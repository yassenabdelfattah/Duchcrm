/**
 * Shopify webhook receiver.
 *
 * Order of operations matters here and is not negotiable:
 *
 *   1. Verify the HMAC against the RAW body, before parsing anything.
 *      Anyone can POST to this URL; the signature is the only proof a request
 *      came from Shopify.
 *   2. Record the delivery, keyed on X-Shopify-Webhook-Id.
 *   3. Only then act on it.
 *
 * Nothing in this function writes to the stock ledger on the strength of an
 * inventory webhook. See DECISIONS.md #2 for why.
 */

import { adminClient, json } from '../_shared/db.ts';
import { config } from '../_shared/env.ts';
import { isValidShopifyWebhook, readWebhookHeaders } from '../_shared/verify-webhook.ts';

interface HandlerResult {
  status: 'processed' | 'ignored' | 'failed';
  reason?: string;
  detail?: Record<string, unknown>;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  // Must be the exact bytes Shopify signed. Parsing first and re-serialising
  // would change key order and whitespace, and the HMAC would never match.
  const rawBody = await req.text();

  const valid = await isValidShopifyWebhook(
    rawBody,
    req.headers.get('x-shopify-hmac-sha256'),
    config.shopifyWebhookSecret,
  );

  if (!valid) {
    // Deliberately terse: never tell an unauthenticated caller why they failed.
    console.warn('Rejected webhook with an invalid signature');
    return json({ error: 'invalid_signature' }, 401);
  }

  const headers = readWebhookHeaders(req.headers);
  if (!headers) {
    return json({ error: 'missing_webhook_headers' }, 400);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const db = adminClient();

  // --- Record the delivery -------------------------------------------------
  //
  // Shopify retries anything it believes failed, and occasionally redelivers
  // something that actually succeeded. The unique constraint on
  // shopify_webhook_id is what makes a replay harmless.
  const { data: existing } = await db
    .from('webhook_events')
    .select('id, status')
    .eq('shopify_webhook_id', headers.webhookId)
    .maybeSingle();

  if (existing && (existing.status === 'processed' || existing.status === 'ignored')) {
    // Already dealt with. Acknowledge so Shopify stops retrying.
    return json({ ok: true, duplicate: true, webhook_id: headers.webhookId });
  }

  let eventId = existing?.id as string | undefined;

  if (!eventId) {
    const { data: inserted, error } = await db
      .from('webhook_events')
      .insert({
        shopify_webhook_id: headers.webhookId,
        shopify_event_id: headers.eventId,
        topic: headers.topic,
        shop_domain: headers.shopDomain,
        api_version: headers.apiVersion,
        payload,
        status: 'processing',
      })
      .select('id')
      .single();

    if (error) {
      // A concurrent delivery of the same webhook won the race to insert.
      if (error.code === '23505') {
        return json({ ok: true, duplicate: true, webhook_id: headers.webhookId });
      }
      console.error('Could not record webhook', error);
      // 500 makes Shopify retry, which is what we want - we have not stored it.
      return json({ error: 'could_not_record' }, 500);
    }
    eventId = inserted.id as string;
  } else {
    await db.from('webhook_events').update({ status: 'processing' }).eq('id', eventId);
  }

  // --- Act on it -----------------------------------------------------------

  let result: HandlerResult;
  try {
    result = await handle(headers.topic, payload, db);
  } catch (error) {
    console.error(`Handler for ${headers.topic} threw`, error);
    await db
      .from('webhook_events')
      .update({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        attempts: (await currentAttempts(db, eventId)) + 1,
      })
      .eq('id', eventId);

    // Non-200 asks Shopify to retry. Our record is in 'failed', so the retry
    // will be processed rather than dismissed as a duplicate.
    return json({ error: 'handler_failed' }, 500);
  }

  await db
    .from('webhook_events')
    .update({
      status: result.status,
      ignored_reason: result.status === 'ignored' ? result.reason : null,
      error: result.status === 'failed' ? result.reason : null,
      processed_at: new Date().toISOString(),
      attempts: (await currentAttempts(db, eventId)) + 1,
    })
    .eq('id', eventId);

  return json({ ok: true, ...result });
});

async function currentAttempts(
  db: ReturnType<typeof adminClient>,
  eventId: string,
): Promise<number> {
  const { data } = await db.from('webhook_events').select('attempts').eq('id', eventId).single();
  return (data?.attempts as number | undefined) ?? 0;
}

// --- Topic routing ---------------------------------------------------------

async function handle(
  topic: string,
  payload: Record<string, unknown>,
  db: ReturnType<typeof adminClient>,
): Promise<HandlerResult> {
  switch (topic) {
    case 'inventory_levels/update':
      return handleInventoryLevelUpdate(payload, db);

    case 'products/update':
    case 'products/create':
      return handleProductUpdate(payload, db);

    // Phase 3. The payload is already stored, so when the order handlers land
    // they can be backfilled from webhook_events rather than lost.
    case 'orders/create':
    case 'orders/updated':
    case 'orders/cancelled':
    case 'refunds/create':
      return { status: 'ignored', reason: 'order_handlers_arrive_in_phase_3' };

    default:
      return { status: 'ignored', reason: `unhandled_topic:${topic}` };
  }
}

/**
 * The echo problem, handled.
 *
 * We push a quantity to Shopify; Shopify tells us the quantity changed. If we
 * treated that as news we would record a movement, which would push again,
 * which would echo again. So this handler classifies and records - it never
 * writes to the ledger.
 *
 * A genuine difference is not corrected here either, because webhook delivery
 * order is not guaranteed: an inventory update can arrive before the
 * orders/create that explains it. The nightly reconciler decides, hours later,
 * when everything in flight has landed.
 */
async function handleInventoryLevelUpdate(
  payload: Record<string, unknown>,
  db: ReturnType<typeof adminClient>,
): Promise<HandlerResult> {
  const inventoryItemId = Number(payload.inventory_item_id);
  const locationId = Number(payload.location_id);
  const available = Number(payload.available);

  if (!Number.isFinite(inventoryItemId) || !Number.isFinite(locationId)) {
    return { status: 'ignored', reason: 'payload_missing_ids' };
  }

  const { data, error } = await db.rpc('classify_inventory_webhook', {
    p_inventory_item_id: inventoryItemId,
    p_shopify_location_id: locationId,
    p_available: Number.isFinite(available) ? available : 0,
  });

  if (error) throw new Error(`classify_inventory_webhook failed: ${error.message}`);

  const classification = (data as { classification?: string })?.classification ?? 'unknown';

  if (classification === 'unmapped') {
    await db.rpc('open_sync_issue', {
      p_type: 'unmapped_inventory_item',
      p_variant_id: null,
      p_location_id: null,
      p_crm_quantity: null,
      p_shopify_quantity: Number.isFinite(available) ? available : null,
      p_details: { inventory_item_id: inventoryItemId, location_id: locationId },
      p_detected_by: 'webhook',
    });
  }

  return {
    status: 'ignored',
    reason: `inventory_${classification}`,
    detail: data as Record<string, unknown>,
  };
}

/** Keeps titles, prices and barcodes current when they are edited in Shopify. */
async function handleProductUpdate(
  payload: Record<string, unknown>,
  db: ReturnType<typeof adminClient>,
): Promise<HandlerResult> {
  const shopifyProductId = Number(payload.id);
  if (!Number.isFinite(shopifyProductId)) {
    return { status: 'ignored', reason: 'payload_missing_product_id' };
  }

  const { data: product, error: productError } = await db
    .from('products')
    .upsert(
      {
        shopify_product_id: shopifyProductId,
        title: String(payload.title ?? 'Untitled'),
        handle: (payload.handle as string | null) ?? null,
        product_type: (payload.product_type as string | null) ?? null,
        vendor: (payload.vendor as string | null) ?? null,
        status: mapProductStatus(payload.status),
        tags: parseTags(payload.tags),
        shopify_synced_at: new Date().toISOString(),
      },
      { onConflict: 'shopify_product_id' },
    )
    .select('id')
    .single();

  if (productError) throw new Error(`Product upsert failed: ${productError.message}`);

  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  let updated = 0;

  for (const raw of variants as Array<Record<string, unknown>>) {
    const sku = (raw.sku as string | null)?.trim();
    if (!sku) continue; // A variant with no SKU cannot be tracked. Reported below.

    const { error } = await db.from('variants').upsert(
      {
        product_id: product.id,
        shopify_variant_id: Number(raw.id),
        shopify_inventory_item_id: raw.inventory_item_id ? Number(raw.inventory_item_id) : null,
        sku,
        barcode: (raw.barcode as string | null) ?? null,
        price_egp: Number(raw.price ?? 0),
        compare_at_price_egp: raw.compare_at_price ? Number(raw.compare_at_price) : null,
        shopify_synced_at: new Date().toISOString(),
      },
      { onConflict: 'sku' },
    );

    if (error) throw new Error(`Variant ${sku} upsert failed: ${error.message}`);
    updated += 1;
  }

  const skipped = variants.length - updated;
  if (skipped > 0) {
    await db.rpc('open_sync_issue', {
      p_type: 'missing_in_crm',
      p_variant_id: null,
      p_location_id: null,
      p_crm_quantity: null,
      p_shopify_quantity: null,
      p_details: {
        reason: 'variants_without_sku',
        shopify_product_id: shopifyProductId,
        count: skipped,
      },
      p_detected_by: 'webhook',
    });
  }

  return { status: 'processed', detail: { variants_updated: updated, skipped } };
}

function mapProductStatus(status: unknown): 'active' | 'draft' | 'archived' {
  const value = String(status ?? '').toLowerCase();
  return value === 'archived' ? 'archived' : value === 'draft' ? 'draft' : 'active';
}

function parseTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}
