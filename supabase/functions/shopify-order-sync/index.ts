/**
 * Brings Shopify's copy of a website order into line with the CRM's.
 *
 * The CRM decides what an order holds (DECISIONS #12). Editing or cancelling
 * a website order queues it in shopify_order_outbox; this sends it:
 *   - straight away, called by the screen that made the change, for that order;
 *   - every minute from the Cloudflare Worker, for anything still waiting.
 *
 * An edit makes the Shopify order hold the CRM order's items and shipping fee,
 * worked out from what Shopify has now (order-edit-plan.ts), so a job that
 * runs twice changes nothing the second time. A cancel cancels it. Neither
 * emails the customer - the owner's choice, since they are phoned anyway -
 * and neither restocks in Shopify: the CRM pushes its own stock numbers
 * afterwards, and those are the ones that count.
 */

import { authorize } from '../_shared/auth.ts';
import { adminClient, corsHeaders, json, withErrorReporting } from '../_shared/db.ts';
import { gid, parseGid, shopifyGraphQL } from '../_shared/shopify.ts';
import { planOrderEdit, type EditStep } from '../_shared/order-edit-plan.ts';

interface SyncRequest {
  /** Send this order now. The order screens use this. */
  order_id?: string;
  /** Send everything due. The Worker uses this. */
  drain?: boolean;
  limit?: number;
}

interface Job {
  order_id: string;
  action: 'edit' | 'cancel';
  requested_at: string;
  attempts: number;
}

interface Target {
  order_id: string;
  order_number: string;
  shopify_order_id: number;
  location_id: string;
  cancelled: boolean;
  shipping_egp: number;
  lines: Array<{ variant_id: string | null; shopify_variant_id: number | null; sku: string; quantity: number }>;
}

interface Outcome {
  details: Record<string, unknown>;
  /** Shopify's updatedAt after our change, so older webhooks cannot undo it. */
  updatedAt?: string | null;
  /** CRM variant ids whose stock is pushed again afterwards. */
  variantIds: string[];
}

type Db = ReturnType<typeof adminClient>;

Deno.serve(withErrorReporting(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Anyone who can change an order calls this right after; what it sends was
  // decided by the database, which already checked their permission.
  const refused = await authorize(req, null);
  if (refused) return refused;

  const db = adminClient();
  let body: SyncRequest = {};
  try {
    body = (await req.json()) as SyncRequest;
  } catch {
    body = { drain: true };
  }

  // The same master switch as stock pushes: off while a bulk import runs.
  const { data: setting } = await db
    .from('settings')
    .select('value')
    .eq('key', 'shopify_push_enabled')
    .maybeSingle();
  if (setting?.value === false) {
    return json({ ok: true, skipped: 'shopify_push_enabled is off' });
  }

  const { data: claimed, error: claimError } = await db.rpc('claim_shopify_order_sync', {
    p_limit: body.limit ?? 20,
    p_order_id: body.order_id ?? null,
  });
  if (claimError) {
    return json({ error: 'claim_failed', detail: claimError.message }, 500);
  }

  const results: Array<{ order_id: string; action: string; ok: boolean; detail?: unknown; error?: string }> = [];

  for (const job of (claimed ?? []) as Job[]) {
    try {
      const target = await loadTarget(db, job.order_id);
      const outcome = job.action === 'cancel' ? await cancelInShopify(target) : await editInShopify(db, target);

      await db.rpc('complete_shopify_order_sync', {
        p_order_id: job.order_id,
        p_requested_at: job.requested_at,
        p_success: true,
        p_error: null,
        p_details: outcome.details,
        p_shopify_updated_at: outcome.updatedAt ?? null,
      });

      await pushStock(db, target.location_id, outcome.variantIds);
      results.push({ order_id: job.order_id, action: job.action, ok: true, detail: outcome.details });
    } catch (error) {
      const message = await explain(error);
      console.error(`Shopify ${job.action} failed for order ${job.order_id}: ${message}`);
      await db.rpc('complete_shopify_order_sync', {
        p_order_id: job.order_id,
        p_requested_at: job.requested_at,
        p_success: false,
        p_error: message,
        p_details: {},
        p_shopify_updated_at: null,
      });
      results.push({ order_id: job.order_id, action: job.action, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return json({ ok: true, processed: results.length - failed, failed, results });
}));

/**
 * The error as it goes on the Sync issue. A refusal for lack of permission
 * also lists what the app does hold on the store, so whoever reads it can see
 * at once which scope still needs approving - the first live run failed for
 * hours on exactly this, reported only as an unreadable null.
 */
async function explain(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (!/ACCESS_DENIED|access denied|required access/i.test(message)) return message;
  try {
    const body = await shopifyGraphQL<{
      currentAppInstallation: { accessScopes: Array<{ handle: string }> } | null;
    }>(SCOPES, {}, { maxAttempts: 1 });
    const granted = body.data?.currentAppInstallation?.accessScopes.map((s) => s.handle).sort() ?? [];
    const missing = ['write_order_edits', 'write_orders'].filter((scope) => !granted.includes(scope));
    return `${message} | The app holds: ${granted.join(', ') || 'nothing readable'}` +
      (missing.length ? ` | Not approved on the store yet: ${missing.join(', ')}` : '');
  } catch {
    return message;
  }
}

const SCOPES = /* GraphQL */ `
  query DuchAppScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

async function loadTarget(db: Db, orderId: string): Promise<Target> {
  const { data, error } = await db.rpc('shopify_order_sync_target', { p_order_id: orderId });
  if (error) throw new Error(`shopify_order_sync_target failed: ${error.message}`);
  return data as Target;
}

/** Shopify's errors and user errors as one line, or null when there were none. */
function problems(
  body: { errors?: Array<{ message: string }> },
  userErrors: Array<{ message: string; code?: string | null }> | undefined,
): string | null {
  const all = [
    ...(body.errors ?? []).map((e) => e.message),
    ...(userErrors ?? []).map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)),
  ];
  return all.length > 0 ? all.join('; ') : null;
}

// --- Edit --------------------------------------------------------------------

const BEGIN = /* GraphQL */ `
  mutation DuchOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        lineItems(first: 100) {
          nodes {
            id
            quantity
            editableQuantity
            sku
            variant {
              id
            }
          }
        }
        shippingLines {
          id
          stagedStatus
          price {
            shopMoney {
              amount
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface BeginData {
  orderEditBegin: {
    calculatedOrder: {
      id: string;
      lineItems: {
        nodes: Array<{
          id: string;
          quantity: number;
          editableQuantity: number;
          sku: string | null;
          variant: { id: string } | null;
        }>;
      };
      shippingLines: Array<{ id: string | null; stagedStatus: string; price: { shopMoney: { amount: string } } }>;
    } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
}

const SET_QUANTITY = /* GraphQL */ `
  mutation DuchOrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: false) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_VARIANT = /* GraphQL */ `
  mutation DuchOrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $allowDuplicates: Boolean) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: $allowDuplicates) {
      userErrors {
        field
        message
      }
    }
  }
`;

const REMOVE_SHIPPING = /* GraphQL */ `
  mutation DuchOrderEditRemoveShipping($id: ID!, $shippingLineId: ID!) {
    orderEditRemoveShippingLine(id: $id, shippingLineId: $shippingLineId) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_SHIPPING = /* GraphQL */ `
  mutation DuchOrderEditAddShipping($id: ID!, $shippingLine: OrderEditAddShippingLineInput!) {
    orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
      userErrors {
        field
        message
      }
    }
  }
`;

const COMMIT = /* GraphQL */ `
  mutation DuchOrderEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order {
        id
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function editInShopify(db: Db, target: Target): Promise<Outcome> {
  // Cancelled since it was queued: the cancel job owns it now.
  if (target.cancelled) {
    return { details: { changed: false, skipped: 'order_cancelled' }, variantIds: [] };
  }

  // Items first, in an edit of their own: they must all go through or none.
  const first = await beginEdit(target);
  const items = planOrderEdit(
    first.lineItems.nodes.map((node) => ({
      id: node.id,
      variantId: parseGid(node.variant?.id),
      sku: node.sku,
      quantity: node.quantity,
      editableQuantity: node.editableQuantity,
    })),
    target.lines.map((line) => ({
      shopifyVariantId: line.shopify_variant_id,
      sku: line.sku,
      quantity: line.quantity,
    })),
  );
  if (items.problems.length > 0) throw new Error(items.problems.join('; '));

  let updatedAt: string | null = null;
  for (const step of items.steps) {
    const problem = await runStep(first.id, step);
    if (problem) throw new Error(`${step.kind}: ${problem}`);
  }
  if (items.steps.length > 0) updatedAt = await commitEdit(first.id, target);

  // Then the shipping fee, in a second edit committed only if every step of
  // it worked. Shopify may refuse to remove the shipping line the customer
  // chose at checkout; committing half of a swap would leave the order with
  // no shipping charge, or two. Refused, the fee stays as it was and the
  // order's history says so - the items have already changed either way.
  let shippingUpdated: boolean | null = null;
  const wantedShipping = Number(target.shipping_egp);
  if (planShipping(first, wantedShipping).length > 0) {
    const second = items.steps.length > 0 ? await beginEdit(target) : first;
    const steps = planShipping(second, wantedShipping);
    shippingUpdated = true;
    for (const step of steps) {
      const problem = await runStep(second.id, step);
      if (problem) {
        console.warn(`Shipping fee not updated on ${target.order_number}: ${problem}`);
        shippingUpdated = false;
        break;
      }
    }
    if (shippingUpdated && steps.length > 0) updatedAt = await commitEdit(second.id, target);
  }

  const changed = items.steps.length > 0 || shippingUpdated === true;

  // Every size on either side has its stock pushed again, even when nothing
  // needed changing. Someone may have edited the order by hand in Shopify as
  // well, and adding an item there takes one off Shopify's count after ours
  // was sent - #1416's BSB-S-BIE showed one short that way. Pushing our
  // number is harmless when Shopify already has it.
  const shopifyIds = first.lineItems.nodes
    .map((node) => parseGid(node.variant?.id))
    .filter((id): id is number => id !== null);
  const { data: before } = shopifyIds.length
    ? await db.from('variants').select('id').in('shopify_variant_id', shopifyIds)
    : { data: [] as Array<{ id: string }> };
  const variantIds = [
    ...new Set([
      ...(before ?? []).map((row) => row.id as string),
      ...target.lines.map((line) => line.variant_id).filter((id): id is string => id !== null),
    ]),
  ];

  if (!changed) {
    // Already the same. The edit session is simply left to expire.
    return {
      details: { changed: false, ...(shippingUpdated === false ? { shipping_updated: false } : {}) },
      variantIds,
    };
  }

  return {
    details: {
      changed: true,
      items_changed: items.steps.length > 0,
      ...(shippingUpdated !== null ? { shipping_updated: shippingUpdated } : {}),
    },
    updatedAt,
    variantIds,
  };
}

type Calculated = NonNullable<BeginData['orderEditBegin']['calculatedOrder']>;

async function beginEdit(target: Target): Promise<Calculated> {
  const begin = await shopifyGraphQL<BeginData>(BEGIN, { id: gid.order(target.shopify_order_id) });
  const problem = problems(begin, begin.data?.orderEditBegin?.userErrors);
  const calculated = begin.data?.orderEditBegin?.calculatedOrder;
  if (problem || !calculated) {
    throw new Error(`orderEditBegin: ${problem ?? 'no calculated order returned'}`);
  }
  return calculated;
}

function planShipping(calculated: Calculated, wanted: number): EditStep[] {
  return planOrderEdit([], [], {
    current: calculated.shippingLines.map((line) => ({
      id: line.id,
      amount: Number(line.price.shopMoney.amount),
      stagedStatus: line.stagedStatus,
    })),
    target: wanted,
  }).steps;
}

async function commitEdit(calculatedOrderId: string, target: Target): Promise<string | null> {
  const commit = await shopifyGraphQL<{
    orderEditCommit: {
      order: { id: string; updatedAt: string } | null;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(COMMIT, { id: calculatedOrderId, staffNote: `Duch CRM - ${target.order_number}` });

  const problem = problems(commit, commit.data?.orderEditCommit?.userErrors);
  if (problem) throw new Error(`orderEditCommit: ${problem}`);
  return commit.data?.orderEditCommit?.order?.updatedAt ?? null;
}

async function runStep(calculatedOrderId: string, step: EditStep): Promise<string | null> {
  switch (step.kind) {
    case 'setQuantity': {
      const body = await shopifyGraphQL<{ orderEditSetQuantity: { userErrors: Array<{ message: string }> } }>(
        SET_QUANTITY,
        { id: calculatedOrderId, lineItemId: step.lineItemId, quantity: step.quantity },
      );
      return problems(body, body.data?.orderEditSetQuantity?.userErrors);
    }
    case 'addVariant': {
      const body = await shopifyGraphQL<{ orderEditAddVariant: { userErrors: Array<{ message: string }> } }>(
        ADD_VARIANT,
        {
          id: calculatedOrderId,
          variantId: gid.variant(step.variantId),
          quantity: step.quantity,
          allowDuplicates: step.allowDuplicates,
        },
      );
      return problems(body, body.data?.orderEditAddVariant?.userErrors);
    }
    case 'removeShipping': {
      const body = await shopifyGraphQL<{ orderEditRemoveShippingLine: { userErrors: Array<{ message: string }> } }>(
        REMOVE_SHIPPING,
        { id: calculatedOrderId, shippingLineId: step.shippingLineId },
      );
      return problems(body, body.data?.orderEditRemoveShippingLine?.userErrors);
    }
    case 'addShipping': {
      const body = await shopifyGraphQL<{ orderEditAddShippingLine: { userErrors: Array<{ message: string }> } }>(
        ADD_SHIPPING,
        {
          id: calculatedOrderId,
          shippingLine: {
            title: 'Shipping',
            price: { amount: step.amount.toFixed(2), currencyCode: 'EGP' },
          },
        },
      );
      return problems(body, body.data?.orderEditAddShippingLine?.userErrors);
    }
  }
}

// --- Cancel ------------------------------------------------------------------

const CANCEL = /* GraphQL */ `
  mutation DuchOrderCancel($orderId: ID!, $staffNote: String) {
    orderCancel(
      orderId: $orderId
      reason: CUSTOMER
      restock: false
      notifyCustomer: false
      staffNote: $staffNote
    ) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        code
        field
        message
      }
    }
  }
`;

async function cancelInShopify(target: Target): Promise<Outcome> {
  const body = await shopifyGraphQL<{
    orderCancel: {
      job: { id: string; done: boolean } | null;
      orderCancelUserErrors: Array<{ code?: string | null; field?: string[]; message: string }>;
    };
  }>(CANCEL, {
    orderId: gid.order(target.shopify_order_id),
    staffNote: `Cancelled in Duch CRM - ${target.order_number}`,
  });

  const userErrors = body.data?.orderCancel?.orderCancelUserErrors ?? [];
  // Cancelled already - in Shopify by hand, or by an earlier run whose answer
  // was lost - is the result we wanted.
  // Shopify no longer has it - deleted by hand while tidying up - is closed
  // as well: there is nothing left there to cancel.
  const already =
    userErrors.length > 0 &&
    userErrors.every((e) => /already.*cancel|cancel.*already|NOT_FOUND|does not exist/i.test(`${e.code ?? ''} ${e.message}`));
  const problem = already ? null : problems(body, userErrors);
  if (problem) throw new Error(`orderCancel: ${problem}`);

  return {
    details: { changed: !already, ...(already ? { already_cancelled: true } : {}) },
    variantIds: target.lines.map((line) => line.variant_id).filter((id): id is string => id !== null),
  };
}

// --- Stock -------------------------------------------------------------------

/**
 * Pushes the CRM's numbers for these variants again, after Shopify moved its
 * own. Queued first, so a push that fails here is still retried by the
 * Worker's drain.
 */
async function pushStock(db: Db, locationId: string, variantIds: string[]): Promise<void> {
  if (variantIds.length === 0) return;
  try {
    await db.rpc('queue_inventory_push', { p_variant_ids: variantIds, p_location_id: locationId });
    await db.functions.invoke('push-inventory', {
      body: { variant_ids: variantIds, location_id: locationId },
    });
  } catch (error) {
    console.warn('Immediate inventory push after an order sync failed; the outbox will retry', error);
  }
}
