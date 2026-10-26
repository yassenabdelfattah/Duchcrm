/**
 * A log line in words: what happened, and the note worth reading under it.
 *
 * A stock movement's reason alone ("adjustment") says nothing about where the
 * piece went. What it belongs to does: an order edited, a count put right
 * against Shopify, a stock count. So the title comes from both, and the note
 * is shown only when a person wrote it - the notes the system writes, in
 * English, either repeat the title or are translated here.
 */

export interface LogRow {
  kind: 'stock' | 'order';
  id: string;
  created_at: string;
  activity_date: string;
  staff_name: string | null;
  action: string;
  event_type: string | null;
  from_status: string | null;
  quantity_delta: number | null;
  variant_id: string | null;
  sku: string | null;
  product_title: string | null;
  variant_label: string | null;
  location_name: string | null;
  note: string | null;
  reference_type: string | null;
  order_id: string | null;
  order_number: string | null;
  order_channel: string | null;
  customer_name: string | null;
  taken_by: string | null;
  taken_out_reason: string | null;
  taken_out_reason_text: string | null;
  taken_out_note: string | null;
}

type T = (key: string, params?: Record<string, unknown>) => string;

/** The groups the log can be narrowed to. */
export const LOG_FILTERS = {
  all: {},
  sales: { kind: 'stock', actions: ['online_order', 'store_sale', 'wholesale'] },
  back: { kind: 'stock', actions: ['return', 'cancellation'] },
  out: { kind: 'stock', actions: ['stock_out', 'stock_out_return'] },
  counts: { kind: 'stock', actions: ['adjustment', 'initial_import'] },
  received: { kind: 'stock', actions: ['production_in'] },
  orders: { kind: 'order' },
} as const satisfies Record<string, { kind?: 'stock' | 'order'; actions?: readonly string[] }>;

export type LogFilter = keyof typeof LOG_FILTERS;

/** Why a piece was taken out, in words: the listed reason, or what was typed. */
function takenOutReason(row: LogRow, t: T): string {
  if (row.taken_out_reason === 'other' && row.taken_out_reason_text) return row.taken_out_reason_text;
  return row.taken_out_reason ? t(`stockOut.reason.${row.taken_out_reason}`) : t('reason.stock_out');
}

export function logTitle(row: LogRow, t: T): string {
  if (row.kind === 'order') {
    switch (row.event_type) {
      case 'created':
        return t('log.what.created');
      case 'fulfillment_change':
        return t(`fulfillment.${row.action}`);
      case 'payment_change':
        return t('log.what.payment', { status: t(`paymentStatus.${row.action}`) });
      case 'items_edited':
      case 'edited':
      case 'shopify_synced':
      case 'shopify_closed_after_return':
      case 'payment_reopened':
      case 'payment_corrected':
      case 'confirmation_call':
      case 'exchange':
        return t(`log.what.${row.event_type}`);
      default:
        return row.event_type ?? row.action;
    }
  }

  switch (row.action) {
    case 'online_order':
    case 'wholesale':
    case 'initial_import':
    case 'production_in':
    case 'cancellation':
      return t(`log.what.${row.action}`);
    case 'store_sale':
      return row.order_channel === 'store' || row.order_channel === 'dm'
        ? t(`log.what.store_sale_${row.order_channel}`)
        : t('log.what.store_sale');
    case 'return':
      if (row.reference_type === 'return') return t('log.what.return');
      if (row.reference_type === 'shopify_refund') return t('log.what.return_shopify');
      return t('log.what.return_manual');
    case 'stock_out':
      return t('log.what.stock_out', { reason: takenOutReason(row, t) });
    case 'stock_out_return':
      return t('log.what.stock_out_return', { reason: takenOutReason(row, t) });
    case 'adjustment':
      switch (row.reference_type) {
        case 'order':
          return t('log.what.order_edit');
        case 'shopify_order_edit':
        case 'sync_issue':
        case 'stock_count':
        case 'pre_crm_cleanup':
          return t(`log.what.${row.reference_type}`);
        default:
          return t('log.what.adjustment');
      }
    default:
      return t(`reason.${row.action}`);
  }
}

// What the system writes, mapped to words - or to nothing, where the title
// already says it.
const SYSTEM_NOTES: Array<[RegExp, string | null]> = [
  [/^customer$/i, 'log.note.customer'],
  [/^inventory$/i, 'log.note.inventory'],
  [/^fraud$/i, 'log.note.fraud'],
  [/^declined$/i, 'log.note.declined'],
  [/^other$/i, 'log.note.other'],
  [/^Order from before the CRM$/i, 'log.note.before_crm'],
  [/^Edited in Shopify$/i, 'log.note.edited_in_shopify'],
  [/^Cancelled by the customer before the courier collected it$/i, 'log.note.cancelled_before_pickup'],
  [/^Shopify edit was recorded as a refund; no money moved$/i, 'log.note.refund_no_money'],
  [/^Order \S+ edited( in Shopify)?$/i, null],
  [/^Order \S+ from before the CRM/i, null],
  [/^Accepted the Shopify count at reconciliation$/i, null],
  [/^Opening stock taken from Shopify at setup$/i, null],
  [/^Refunded in Shopify$/i, null],
];

/** The note under the line, if there is one worth reading. */
export function logNote(row: LogRow, t: T): string | null {
  // Taken out: who and why are in the line already; the taking-out's own
  // note is the one a person wrote.
  if (row.reference_type === 'stock_out') return row.taken_out_note?.trim() || null;

  const note = row.note?.trim();
  if (!note) return null;
  for (const [pattern, key] of SYSTEM_NOTES) {
    if (pattern.test(note)) return key ? t(key) : null;
  }
  return note;
}
