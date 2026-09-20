/**
 * Nightly reconciliation between CRM stock and Shopify.
 *
 * It reports; it does not repair. If the two disagree, a human decides which
 * is right, because "the counts differ" has several very different causes -
 * someone edited stock in the Shopify admin, a garment was damaged and never
 * written off, a webhook was missed - and each wants a different answer. An
 * automatic fix would paper over all of them and destroy the evidence.
 *
 * Runs well after the day's webhooks have settled, which is what makes a
 * difference here meaningful rather than just a delivery that is still in
 * flight.
 */

import { adminClient, corsHeaders, json, withErrorReporting } from '../_shared/db.ts';
import { config } from '../_shared/env.ts';
import { fetchAllInventoryLevels } from '../_shared/shopify.ts';

Deno.serve(withErrorReporting(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const db = adminClient();
  const startedAt = Date.now();

  // --- The cache should always equal the ledger ----------------------------
  //
  // This is an internal consistency check, not a Shopify one. If it ever
  // returns a row, something is wrong with our own triggers and that matters
  // far more than a Shopify mismatch.
  const { data: drift, error: driftError } = await db.rpc('verify_stock_levels');
  if (driftError) {
    return json({ error: 'verify_failed', detail: driftError.message }, 500);
  }

  const driftRows = (drift ?? []) as Array<{
    variant_id: string;
    location_id: string;
    cached_quantity: number;
    ledger_quantity: number;
  }>;

  for (const row of driftRows) {
    console.error('Stock level cache has drifted from the ledger', row);
    await db.rpc('open_sync_issue', {
      p_type: 'quantity_mismatch',
      p_variant_id: row.variant_id,
      p_location_id: row.location_id,
      p_crm_quantity: row.cached_quantity,
      p_shopify_quantity: null,
      p_details: {
        internal: true,
        ledger_quantity: row.ledger_quantity,
        note: 'The running total disagrees with the ledger. This is a CRM bug, not a Shopify one.',
      },
      p_detected_by: 'nightly_reconcile',
    });
  }

  // --- Compare against Shopify --------------------------------------------

  const shopifyLocationId = Number(config.shopifyLocationId);
  if (!Number.isFinite(shopifyLocationId)) {
    return json({ error: 'invalid_shopify_location_id' }, 500);
  }

  let levels;
  try {
    levels = await fetchAllInventoryLevels(shopifyLocationId);
  } catch (error) {
    console.error('Could not read inventory levels from Shopify', error);
    return json(
      { error: 'shopify_read_failed', detail: error instanceof Error ? error.message : String(error) },
      502,
    );
  }

  const { data: setting } = await db
    .from('settings')
    .select('value')
    .eq('key', 'shopify_inventory_state')
    .maybeSingle();

  const state = (setting?.value as string | undefined) === 'on_hand' ? 'on_hand' : 'available';

  const rows = levels.map((level) => ({
    inventory_item_id: level.inventory_item_id,
    location_id: level.location_id,
    available: state === 'on_hand' ? level.on_hand : level.available,
  }));

  const { data: result, error } = await db.rpc('reconcile_shopify_inventory', { p_rows: rows });

  if (error) {
    return json({ error: 'reconcile_failed', detail: error.message }, 500);
  }

  const summary = {
    ok: true,
    compared_state: state,
    internal_drift_rows: driftRows.length,
    ...(result as Record<string, unknown>),
    duration_ms: Date.now() - startedAt,
  };

  console.log('Reconciliation finished', summary);
  return json(summary);
}));
