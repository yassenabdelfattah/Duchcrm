/**
 * Working out how to make a Shopify order hold what the CRM order holds.
 *
 * The CRM never says "add one hoodie" to Shopify; it says "the order is these
 * items", and this works out the steps from what Shopify has now. So a job
 * that runs twice, or after someone also changed the order in Shopify, still
 * lands on the CRM's version - the same reason stock pushes send the total
 * rather than the change (DECISIONS #1, rule three).
 *
 * No network and no Deno here, so it is tested directly:
 * tests/order-edit-plan.test.ts.
 */

/** A line on Shopify's calculated order (orderEditBegin). */
export interface ShopifyEditLine {
  /** The calculated line item's id, which the edit mutations take. */
  id: string;
  /** Shopify's numeric variant id; null for a custom item. */
  variantId: number | null;
  sku: string | null;
  /** What the order holds now, after any earlier edits. */
  quantity: number;
  /** How much of that can still change: the part not yet fulfilled. */
  editableQuantity: number;
}

/** A line the CRM order holds, summed per variant. */
export interface TargetLine {
  shopifyVariantId: number | null;
  sku: string;
  quantity: number;
}

export interface ShopifyShippingLine {
  id: string | null;
  amount: number;
  /** NONE, ADDED or REMOVED within the current edit. */
  stagedStatus: string;
}

export type EditStep =
  | { kind: 'setQuantity'; lineItemId: string; quantity: number }
  | { kind: 'addVariant'; variantId: number; quantity: number; allowDuplicates: boolean }
  | { kind: 'removeShipping'; shippingLineId: string }
  | { kind: 'addShipping'; amount: number };

export interface EditPlan {
  steps: EditStep[];
  /** Things that cannot be done. A plan with problems must not be committed. */
  problems: string[];
}

const keyOf = (variantId: number | null, sku: string | null) =>
  variantId !== null ? `v:${variantId}` : `sku:${(sku ?? '').trim().toUpperCase()}`;

const money = (value: number) => Math.round(value * 100);

export function planOrderEdit(
  current: ShopifyEditLine[],
  target: TargetLine[],
  shipping?: { current: ShopifyShippingLine[]; target: number },
): EditPlan {
  const steps: EditStep[] = [];
  const problems: string[] = [];

  const lines = new Map<string, ShopifyEditLine[]>();
  for (const line of current) {
    const key = keyOf(line.variantId, line.sku);
    lines.set(key, [...(lines.get(key) ?? []), line]);
  }

  const wanted = new Map<string, { quantity: number; variantId: number | null; sku: string }>();
  for (const line of target) {
    const key = keyOf(line.shopifyVariantId, line.sku);
    const existing = wanted.get(key);
    wanted.set(key, {
      quantity: (existing?.quantity ?? 0) + line.quantity,
      variantId: line.shopifyVariantId,
      sku: line.sku,
    });
  }

  const decreases: EditStep[] = [];
  const increases: EditStep[] = [];

  for (const key of new Set([...lines.keys(), ...wanted.keys()])) {
    const have = lines.get(key) ?? [];
    const want = wanted.get(key);
    const target = want?.quantity ?? 0;
    const now = have.reduce((sum, line) => sum + line.quantity, 0);
    if (target === now) continue;

    const sku = want?.sku ?? have[0]?.sku ?? key;

    // Shopify will not change a fulfilled unit. The CRM never fulfils in
    // Shopify, so this only happens if someone did it there by hand.
    const fixed = have.reduce((sum, line) => sum + (line.quantity - line.editableQuantity), 0);
    if (target < fixed) {
      problems.push(`${sku}: ${fixed} already fulfilled in Shopify, cannot go down to ${target}`);
      continue;
    }

    if (target > now) {
      const extra = target - now;
      // A line still open is raised. One taken to zero by an earlier edit is
      // left alone and the item added afresh, which is what Shopify's own
      // admin does - a removed line is not one it lets you edit back up.
      const editable = have.find((line) => line.editableQuantity > 0);
      if (editable) {
        increases.push({ kind: 'setQuantity', lineItemId: editable.id, quantity: editable.quantity + extra });
      } else if (want?.variantId != null) {
        increases.push({
          kind: 'addVariant',
          variantId: want.variantId,
          quantity: extra,
          allowDuplicates: have.length > 0,
        });
      } else {
        problems.push(`${sku}: not linked to a Shopify variant, so it cannot be added in Shopify`);
      }
      continue;
    }

    // Fewer: take from the last lines first, never below what is fulfilled.
    let remove = now - target;
    for (const line of [...have].reverse()) {
      if (remove === 0) break;
      const take = Math.min(remove, line.editableQuantity);
      if (take === 0) continue;
      decreases.push({ kind: 'setQuantity', lineItemId: line.id, quantity: line.quantity - take });
      remove -= take;
    }
  }

  steps.push(...decreases, ...increases);

  if (shipping) {
    const live = shipping.current.filter((line) => line.stagedStatus !== 'REMOVED');
    const now = live.reduce((sum, line) => sum + money(line.amount), 0);
    if (now !== money(shipping.target)) {
      for (const line of live) {
        if (line.id) steps.push({ kind: 'removeShipping', shippingLineId: line.id });
      }
      if (money(shipping.target) > 0) steps.push({ kind: 'addShipping', amount: shipping.target });
    }
  }

  return { steps, problems };
}
