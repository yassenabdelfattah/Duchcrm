/**
 * One-way import of the Shopify catalogue into the CRM.
 *
 * Run once at setup, and again whenever products are added in Shopify. It is
 * safe to re-run: products and variants are matched on their Shopify ids and
 * SKUs, so a second run updates rather than duplicates.
 *
 * It deliberately does NOT import stock quantities. The CRM owns stock, and
 * the opening count is recorded through the ledger as an `initial_import`
 * movement - see the import_opening_stock flag below.
 */

import { adminClient, corsHeaders, json, withErrorReporting } from '../_shared/db.ts';
import { config } from '../_shared/env.ts';
import {
  fetchAllInventoryLevels,
  parseGid,
  PRODUCTS_QUERY,
  shopifyGraphQL,
  type GraphQLResponse,
} from '../_shared/shopify.ts';

interface ImportRequest {
  /**
   * Also write an initial_import movement bringing CRM stock up to what
   * Shopify currently reports. Intended for the very first run only; running
   * it twice would double the opening stock, so it refuses if the ledger
   * already has movements for that variant.
   */
  import_opening_stock?: boolean;
  /** Which CRM location the opening stock belongs to. */
  location_id?: string;
  dry_run?: boolean;
}

interface ShopifyVariantNode {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  position: number;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: {
    id: string;
    tracked: boolean;
    measurement?: { weight?: { value: number; unit: string } | null } | null;
  };
}

interface ShopifyProductsPage {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyProductNode[];
  };
}

interface ShopifyProductNode {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  productType: string | null;
  vendor: string | null;
  status: string;
  tags: string[];
  featuredMedia?: { preview?: { image?: { url: string } | null } | null } | null;
  variants: { nodes: ShopifyVariantNode[] };
}

Deno.serve(withErrorReporting(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const db = adminClient();
  let body: ImportRequest = {};
  try {
    body = (await req.json()) as ImportRequest;
  } catch {
    body = {};
  }

  const summary = {
    products_seen: 0,
    products_written: 0,
    variants_written: 0,
    variants_skipped_no_sku: [] as string[],
    opening_stock_movements: 0,
    dry_run: body.dry_run === true,
  };

  // --- Walk the catalogue --------------------------------------------------

  let cursor: string | null = null;

  do {
    // Annotated explicitly. Written inline, the response type would depend on
    // `cursor` while `cursor` is assigned from the response at the bottom of
    // the loop - a cycle TypeScript resolves by falling back to `any`, which
    // silently switches off type checking for the whole loop body.
    const result: GraphQLResponse<ShopifyProductsPage> =
      await shopifyGraphQL<ShopifyProductsPage>(PRODUCTS_QUERY, { cursor });

    if (result.errors?.length) {
      return json(
        { error: 'shopify_query_failed', detail: result.errors.map((e) => e.message) },
        502,
      );
    }

    const page = result.data?.products;
    if (!page) break;

    for (const node of page.nodes) {
      summary.products_seen += 1;
      const shopifyProductId = parseGid(node.id);
      if (shopifyProductId === null) continue;

      if (summary.dry_run) {
        summary.products_written += 1;
        // Walk the variants rather than counting the ones with a SKU, so a
        // dry run reports the same skips the real run would. Counting only
        // the good ones left variants_skipped_no_sku empty on every dry run -
        // and that list is the whole point of running one, since it is what
        // setup checks before importing for real.
        for (const variant of node.variants.nodes) {
          if (variant.sku?.trim()) {
            summary.variants_written += 1;
          } else {
            summary.variants_skipped_no_sku.push(`${node.title} / ${variant.title}`);
          }
        }
        continue;
      }

      const { data: product, error: productError } = await db
        .from('products')
        .upsert(
          {
            shopify_product_id: shopifyProductId,
            title: node.title,
            handle: node.handle,
            description: node.descriptionHtml,
            product_type: node.productType,
            vendor: node.vendor,
            status: node.status?.toLowerCase() === 'archived'
              ? 'archived'
              : node.status?.toLowerCase() === 'draft'
                ? 'draft'
                : 'active',
            tags: node.tags ?? [],
            image_url: node.featuredMedia?.preview?.image?.url ?? null,
            shopify_synced_at: new Date().toISOString(),
          },
          { onConflict: 'shopify_product_id' },
        )
        .select('id')
        .single();

      if (productError) {
        return json(
          { error: 'product_upsert_failed', detail: productError.message, summary },
          500,
        );
      }
      summary.products_written += 1;

      for (const variant of node.variants.nodes) {
        const sku = variant.sku?.trim();

        // A variant with no SKU cannot be scanned, labelled or reconciled.
        // Rather than inventing one, it is reported so someone can fix it in
        // Shopify - an invented SKU would silently diverge from the barcode
        // printed on the actual garment.
        if (!sku) {
          summary.variants_skipped_no_sku.push(`${node.title} / ${variant.title}`);
          continue;
        }

        const options = Object.fromEntries(
          (variant.selectedOptions ?? []).map((o) => [o.name, o.value]),
        );
        const findOption = (...names: string[]) => {
          for (const [key, value] of Object.entries(options)) {
            if (names.some((n) => key.toLowerCase() === n)) return value;
          }
          return null;
        };

        const weight = variant.inventoryItem?.measurement?.weight;
        const weightGrams = weight
          ? weight.unit === 'KILOGRAMS'
            ? Math.round(weight.value * 1000)
            : weight.unit === 'GRAMS'
              ? Math.round(weight.value)
              : null
          : null;

        const { error: variantError } = await db.from('variants').upsert(
          {
            product_id: product.id,
            shopify_variant_id: parseGid(variant.id),
            shopify_inventory_item_id: parseGid(variant.inventoryItem?.id),
            sku,
            barcode: variant.barcode,
            size: findOption('size', 'مقاس'),
            color: findOption('color', 'colour', 'لون'),
            options,
            price_egp: Number(variant.price ?? 0),
            compare_at_price_egp: variant.compareAtPrice ? Number(variant.compareAtPrice) : null,
            weight_grams: weightGrams,
            position: variant.position ?? 1,
            track_inventory: variant.inventoryItem?.tracked ?? true,
            shopify_synced_at: new Date().toISOString(),
          },
          { onConflict: 'sku' },
        );

        if (variantError) {
          return json(
            { error: 'variant_upsert_failed', sku, detail: variantError.message, summary },
            500,
          );
        }
        summary.variants_written += 1;
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // --- Opening stock -------------------------------------------------------

  if (body.import_opening_stock && body.location_id && !summary.dry_run) {
    const result = await importOpeningStock(db, body.location_id);
    if ('error' in result) return json({ ...result, summary }, 500);
    summary.opening_stock_movements = result.movements;
  }

  return json({ ok: true, summary });
}));

async function importOpeningStock(
  db: ReturnType<typeof adminClient>,
  locationId: string,
): Promise<{ movements: number } | { error: string; detail?: string }> {
  const shopifyLocationId = Number(config.shopifyLocationId);
  if (!Number.isFinite(shopifyLocationId)) {
    return { error: 'invalid_shopify_location_id' };
  }

  const levels = await fetchAllInventoryLevels(shopifyLocationId);

  const { data: variants, error } = await db
    .from('variants')
    .select('id, sku, shopify_inventory_item_id')
    .not('shopify_inventory_item_id', 'is', null);

  if (error) return { error: 'variant_lookup_failed', detail: error.message };

  const byInventoryItem = new Map<number, string>(
    (variants ?? []).map((v) => [v.shopify_inventory_item_id as number, v.id as string]),
  );

  // Variants that already have ledger history are left alone. Running the
  // opening import twice would otherwise double everyone's stock.
  const { data: alreadyMoved } = await db
    .from('stock_movements')
    .select('variant_id')
    .eq('location_id', locationId);

  const seen = new Set((alreadyMoved ?? []).map((m) => m.variant_id as string));

  const movements = levels
    .map((level) => ({
      variant_id: byInventoryItem.get(level.inventory_item_id),
      quantity_delta: level.available,
    }))
    .filter(
      (m): m is { variant_id: string; quantity_delta: number } =>
        Boolean(m.variant_id) && !seen.has(m.variant_id as string) && m.quantity_delta !== 0,
    );

  if (movements.length === 0) return { movements: 0 };

  const { error: rpcError } = await db.rpc('record_stock_movements', {
    p_location_id: locationId,
    p_reason: 'initial_import',
    p_movements: movements,
    p_reference_type: 'shopify_import',
    p_reference_id: new Date().toISOString().slice(0, 10),
    p_note: 'Opening stock taken from Shopify at setup',
    p_idempotency_key: `opening-import:${locationId}`,
  });

  if (rpcError) return { error: 'opening_stock_failed', detail: rpcError.message };

  return { movements: movements.length };
}
