/**
 * Pushes CRM stock quantities to Shopify.
 *
 * Called two ways:
 *   - by the sale screen right after a sale, for an immediate update;
 *   - by the Cloudflare Worker every minute, draining anything the fast path
 *     missed.
 *
 * Both routes go through the outbox, so a push that fails here is retried
 * rather than lost.
 */

import { adminClient, corsHeaders, json, withErrorReporting } from '../_shared/db.ts';
import { setInventoryQuantity } from '../_shared/shopify.ts';

interface PushRequest {
  /** Drain the outbox. The Worker uses this. */
  drain?: boolean;
  /** Push these specific variants now. The sale screen uses this. */
  variant_ids?: string[];
  location_id?: string;
  limit?: number;
}

interface PushOutcome {
  variant_id: string;
  location_id: string;
  ok: boolean;
  quantity?: number;
  error?: string;
}

Deno.serve(withErrorReporting(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const db = adminClient();
  let body: PushRequest = {};
  try {
    body = (await req.json()) as PushRequest;
  } catch {
    body = { drain: true };
  }

  // The master switch, so a bulk import can be run without hammering Shopify.
  const { data: setting } = await db
    .from('settings')
    .select('value')
    .eq('key', 'shopify_push_enabled')
    .maybeSingle();

  if (setting?.value === false) {
    return json({ ok: true, skipped: 'shopify_push_enabled is off' });
  }

  const { data: stateSetting } = await db
    .from('settings')
    .select('value')
    .eq('key', 'shopify_inventory_state')
    .maybeSingle();

  const inventoryState =
    (stateSetting?.value as string | undefined) === 'on_hand' ? 'on_hand' : 'available';

  // --- Decide what to push -------------------------------------------------

  let targets: Array<{ variant_id: string; location_id: string }> = [];

  if (body.variant_ids?.length && body.location_id) {
    targets = body.variant_ids.map((variant_id) => ({
      variant_id,
      location_id: body.location_id as string,
    }));
  } else {
    const { data, error } = await db.rpc('claim_sync_outbox', {
      p_limit: body.limit ?? 50,
    });
    if (error) {
      console.error('Could not claim outbox rows', error);
      return json({ error: 'claim_failed', detail: error.message }, 500);
    }
    targets = (data ?? []) as Array<{ variant_id: string; location_id: string }>;
  }

  if (targets.length === 0) {
    return json({ ok: true, pushed: 0, results: [] });
  }

  // --- Push ----------------------------------------------------------------

  const results: PushOutcome[] = [];

  for (const target of targets) {
    try {
      const outcome = await pushOne(db, target.variant_id, target.location_id, inventoryState);
      results.push(outcome);
      await db.rpc('resolve_sync_outbox', {
        p_variant_id: target.variant_id,
        p_location_id: target.location_id,
        p_success: outcome.ok,
        p_error: outcome.error ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Push failed for variant ${target.variant_id}`, error);
      results.push({ ...target, ok: false, error: message });
      await db.rpc('resolve_sync_outbox', {
        p_variant_id: target.variant_id,
        p_location_id: target.location_id,
        p_success: false,
        p_error: message,
      });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return json({
    ok: true,
    pushed: succeeded,
    failed: results.length - succeeded,
    results,
  });
}));

async function pushOne(
  db: ReturnType<typeof adminClient>,
  variantId: string,
  locationId: string,
  inventoryState: 'available' | 'on_hand',
): Promise<PushOutcome> {
  // begin_inventory_push reads the current quantity and what we last told
  // Shopify, and returns a row carrying a fresh idempotency key.
  const { data: push, error } = await db.rpc('begin_inventory_push', {
    p_variant_id: variantId,
    p_location_id: locationId,
  });

  if (error) throw new Error(`begin_inventory_push failed: ${error.message}`);

  const row = push as {
    id: string;
    shopify_inventory_item_id: number;
    shopify_location_id: number;
    quantity: number;
    compare_quantity: number | null;
    idempotency_key: string;
  };

  let result = await setInventoryQuantity({
    inventoryItemId: row.shopify_inventory_item_id,
    locationId: row.shopify_location_id,
    quantity: row.quantity,
    // Shopify's optimistic lock. If the storefront sold a unit between our
    // read and our write, this fails instead of overwriting that sale.
    compareQuantity: row.compare_quantity,
    idempotencyKey: row.idempotency_key,
    referenceDocumentUri: `https://duch.store/crm/variants/${variantId}`,
    name: inventoryState,
  });

  // A compare-and-set failure is not an error - it means Shopify moved while
  // we were working. The CRM is still the source of truth for what the
  // quantity should be, so we drop the stale comparison and set it outright.
  // A new idempotency key is required: reusing the old one with different
  // arguments returns IDEMPOTENCY_KEY_PARAMETER_MISMATCH.
  const compareFailed = result.userErrors.some(
    (e) =>
      e.code === 'COMPARE_QUANTITY_STALE' ||
      /compare/i.test(e.message ?? ''),
  );

  if (!result.ok && compareFailed) {
    result = await setInventoryQuantity({
      inventoryItemId: row.shopify_inventory_item_id,
      locationId: row.shopify_location_id,
      quantity: row.quantity,
      compareQuantity: null,
      idempotencyKey: crypto.randomUUID(),
      referenceDocumentUri: `https://duch.store/crm/variants/${variantId}`,
      name: inventoryState,
    });
  }

  const errorText = result.ok
    ? null
    : result.userErrors.map((e) => `${e.code ?? 'ERROR'}: ${e.message}`).join('; ');

  await db.rpc('complete_inventory_push', {
    p_push_id: row.id,
    p_status: result.ok ? 'succeeded' : 'failed',
    p_response: result.raw as Record<string, unknown>,
    p_error: errorText,
  });

  return {
    variant_id: variantId,
    location_id: locationId,
    ok: result.ok,
    quantity: row.quantity,
    error: errorText ?? undefined,
  };
}
