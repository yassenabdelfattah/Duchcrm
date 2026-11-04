import { cairoDatePlusDays, cairoStartOfDayISO } from '@duch/shared';
import { addDays } from '../../lib/reportMath';
import type { StatusTone } from '../../components/ui';

/**
 * What the orders screen knows, with no React in it: the row v_order_list
 * returns, the lists and filters, and which money and delivery steps an
 * order offers whom. The components in this folder all read from here, so
 * the row's button, the opened order and the bulk actions agree.
 */

export type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface OrderItem {
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_price_egp: number;
  total_egp: number;
  /** Pieces of it back from the customer, checked in. */
  returned?: number;
  /** Pieces of it on their way back - refused at the door, not checked in yet. */
  coming_back?: number;
}

export interface OrderRow {
  id: string;
  order_number: string;
  channel: string;
  created_at: string;
  fulfillment_status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal_egp: number;
  discount_egp: number;
  shipping_egp: number;
  total_egp: number;
  cancelled_at: string | null;
  note: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  shipment_id: string | null;
  tracking_number: string | null;
  courier: string | null;
  driver_name: string | null;
  shipment_status: string | null;
  /** What the parcel's label asks the customer for; 0 when paid before it left. */
  cod_amount_egp: number | null;
  handed_over_at: string | null;
  delivered_at: string | null;
  items: OrderItem[];
  unit_count: number;
  stage: 'to_ship' | 'on_the_road' | 'delivered' | 'back' | 'cancelled';
  stage_since: string;
  /** Set on an order that came from the website. */
  shopify_order_id: number | null;
  /** A change made here has not reached Shopify yet. */
  shopify_pending: boolean;
  /** On a replacement: the order it was exchanged from. */
  exchange_for_order_id: string | null;
  exchange_for_order_number: string | null;
  /** On a replacement that cost less: owed back to the customer. */
  exchange_refund_egp: number;
  exchange_refunded_at: string | null;
  /** On an original: the replacements made for it. */
  exchanged_in: string | null;
  /** Nothing left to do on it: it lives in the archive. */
  is_closed: boolean;
  customer_governorate: string | null;
  /** Pieces back the customer had not paid for: off what the order owes. */
  returned_off_egp: number;
  /** Paid for and sent back: owed to the customer until paid back. */
  return_refund_owed_egp: number;
  return_refunded_egp: number;
}

export type SettleAction =
  | 'mark_order_paid'
  | 'complete_own_delivery'
  | 'mark_courier_delivered'
  | 'mark_exchange_refunded'
  | 'mark_return_refunded';

export type BulkAction = 'mark_order_paid' | 'mark_courier_delivered';

export const PAGE_SIZE = 50;

/** A parcel with the courier this long is late - the same line the custody report draws. */
export const COURIER_LATE_DAYS = 7;

// --- Lists, filters and order -----------------------------------------------------

export type TabKey = 'open' | 'to_ship' | 'on_the_road' | 'late' | 'owed' | 'back' | 'archive';
export const TABS: TabKey[] = ['open', 'to_ship', 'on_the_road', 'late', 'owed', 'back', 'archive'];

export interface Filters {
  channel: string;
  method: string;
  paid: '' | 'paid' | 'unpaid';
  delivery: '' | 'accurate' | 'own';
  period: '' | 'today' | '7' | '30' | 'range';
  /** yyyy-mm-dd, for period "range". */
  from: string;
  to: string;
  governorate: string;
  exchange: boolean;
  hasNote: boolean;
}

export const NO_FILTERS: Filters = {
  channel: '',
  method: '',
  paid: '',
  delivery: '',
  period: '',
  from: '',
  to: '',
  governorate: '',
  exchange: false,
  hasNote: false,
};

export type SortKey = 'newest' | 'oldest' | 'value' | 'waiting';
export const SORTS: SortKey[] = ['newest', 'oldest', 'value', 'waiting'];

export const STORAGE_KEY = 'duch.orders.view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST builder's generics are not worth spelling out here
export type Query = any;

/**
 * Narrows a query to one list. "Owed" is delivered and not paid: the
 * customer has it, we do not have the money. "Late" is the same seven days
 * the custody report and the home screen use.
 */
export function applyTab(query: Query, tab: TabKey): Query {
  switch (tab) {
    case 'open':
      return query.eq('is_closed', false);
    case 'to_ship':
    case 'on_the_road':
      return query.eq('stage', tab);
    case 'late':
      return query
        .eq('stage', 'on_the_road')
        .neq('courier', 'own')
        .lt('stage_since', new Date(Date.now() - COURIER_LATE_DAYS * 86_400_000).toISOString());
    case 'owed':
      return query.eq('stage', 'delivered').eq('payment_status', 'pending');
    case 'back':
      return query.eq('stage', 'back').eq('is_closed', false);
    case 'archive':
      return query.eq('is_closed', true);
  }
}

export function applyFilters(query: Query, filters: Filters): Query {
  let q = query;
  if (filters.channel) q = q.eq('channel', filters.channel);
  if (filters.method) q = q.eq('payment_method', filters.method);
  if (filters.paid === 'paid') q = q.eq('payment_status', 'paid');
  if (filters.paid === 'unpaid') q = q.eq('payment_status', 'pending');
  if (filters.delivery) q = q.eq('courier', filters.delivery);
  if (filters.governorate) q = q.eq('customer_governorate', filters.governorate);
  if (filters.exchange) q = q.not('exchange_for_order_id', 'is', null);
  if (filters.hasNote) q = q.not('note', 'is', null);
  // Days are Cairo days, as everywhere else - not the device's midnight.
  if (filters.period === 'range') {
    if (filters.from) q = q.gte('created_at', cairoStartOfDayISO(filters.from));
    if (filters.to) q = q.lt('created_at', cairoStartOfDayISO(addDays(filters.to, 1)));
  } else if (filters.period === 'today') {
    q = q.gte('created_at', cairoStartOfDayISO());
  } else if (filters.period) {
    // "7" is today and the six days before it, as the reports count it.
    q = q.gte('created_at', cairoStartOfDayISO(cairoDatePlusDays(1 - Number(filters.period))));
  }
  return q;
}

export function applySort(query: Query, sort: SortKey): Query {
  switch (sort) {
    case 'oldest':
      return query.order('created_at', { ascending: true });
    case 'value':
      return query.order('total_egp', { ascending: false }).order('created_at', { ascending: false });
    case 'waiting':
      return query.order('stage_since', { ascending: true });
    default:
      return query.order('created_at', { ascending: false });
  }
}

export function readSavedView(): { tab: TabKey; filters: Filters; sort: SortKey } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      tab?: string;
      filters?: Partial<Filters>;
      sort?: SortKey;
    } | null;
    if (saved) {
      // "all" was the first list before the archive existed.
      const tab = saved.tab === 'all' ? 'open' : (saved.tab as TabKey);
      return {
        tab: TABS.includes(tab) ? tab : 'open',
        filters: { ...NO_FILTERS, ...saved.filters },
        sort: SORTS.includes(saved.sort as SortKey) ? (saved.sort as SortKey) : 'newest',
      };
    }
  } catch {
    // Private browsing or a corrupt value: start from the defaults.
  }
  return { tab: 'open', filters: NO_FILTERS, sort: 'newest' };
}

// --- What an order offers whom -----------------------------------------------------

/**
 * Nothing more is owed on an order that was cancelled or whose goods came
 * back. The database refuses to mark either paid; the payment status of a
 * returned courier parcel stays unpaid only so its statement line is still
 * expected.
 */
export function isClosed(row: { cancelled_at: string | null; fulfillment_status: string }): boolean {
  return (
    row.cancelled_at !== null ||
    row.fulfillment_status === 'returned' ||
    row.fulfillment_status === 'return_in_transit'
  );
}

export interface Permissions {
  maySettle: boolean;
  mayEdit: boolean;
  mayDeliver: boolean;
  mayCancel: boolean;
  mayExchange: boolean;
  mayReturn: boolean;
  isOwner: boolean;
}

/**
 * Where an order can be taken back from: out with a courier or driver, on its
 * way back, or already with the customer. Before it leaves it is cancelled
 * instead. The same statuses the returns lookup accepts.
 */
export const RETURNABLE = new Set(['in_transit', 'out_for_delivery', 'delivery_failed', 'return_in_transit', 'delivered']);

/**
 * Which of the money and delivery steps an order offers this person. One
 * place, so the row's button, the opened order and the bulk actions agree.
 */
export function stepsFor(row: OrderRow, p: Permissions) {
  const cancelled = row.cancelled_at !== null;
  // Out with one of our own drivers: "cash received" records it delivered and
  // paid in one step, so it replaces mark paid there.
  const deliverable =
    p.maySettle && !cancelled && row.courier === 'own' && row.shipment_status === 'out_for_delivery';
  // With a courier and the customer has it: delivered, while the courier
  // still holds the cash. The payment is left for their statement.
  const courierDelivered =
    p.mayDeliver && !cancelled && row.stage === 'on_the_road' && row.courier !== null && row.courier !== 'own';
  // Every unpaid order but card, which is paid at the till - the owner's
  // decision, cash on delivery included.
  const settleable =
    p.maySettle && !isClosed(row) && !deliverable && row.payment_status === 'pending' && row.payment_method !== 'card';
  const refundOwed = p.maySettle && Number(row.exchange_refund_egp) > 0 && !row.exchange_refunded_at;
  const returnRefundOwed = p.maySettle && Number(row.return_refund_owed_egp) > 0;
  return { cancelled, deliverable, courierDelivered, settleable, refundOwed, returnRefundOwed };
}

/** The one step shown on the line itself: what this order is waiting for. */
export function nextStep(
  row: OrderRow,
  p: Permissions,
  t: Translate,
): { rpc: SettleAction; label: string } | null {
  const steps = stepsFor(row, p);
  if (steps.deliverable) {
    return {
      rpc: 'complete_own_delivery',
      label: row.payment_method === 'cod' ? t('queue.cashReceived') : t('queue.delivered'),
    };
  }
  if (steps.courierDelivered) return { rpc: 'mark_courier_delivered', label: t('orders.customerReceived') };
  if (steps.settleable && row.stage === 'delivered') return { rpc: 'mark_order_paid', label: t('orders.markPaid') };
  if (steps.refundOwed) return { rpc: 'mark_exchange_refunded', label: t('exchange.markRefunded') };
  if (steps.returnRefundOwed) return { rpc: 'mark_return_refunded', label: t('exchange.markRefunded') };
  return null;
}

/**
 * What the customer pays: goods after discount, plus shipping, less any pieces
 * that came back unpaid for - refused at the door, or returned off a tab.
 */
export const payable = (row: Pick<OrderRow, 'total_egp' | 'shipping_egp' | 'returned_off_egp'>) =>
  Number(row.total_egp) + Number(row.shipping_egp) - Number(row.returned_off_egp ?? 0);

// --- Where an order is now --------------------------------------------------------

export function sinceLabel(iso: string, t: Translate): string {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return t('orders.since.now');
  if (hours < 48) return t('queue.ageHours', { count: hours });
  return t('queue.ageDays', { count: Math.floor(hours / 24) });
}

export function courierName(row: OrderRow, t: Translate): string {
  if (row.courier === 'own') return row.driver_name ?? t('orders.courier.own');
  if (row.courier === 'accurate') return t('orders.courier.accurate');
  return row.courier ?? '—';
}

/** The tracker line: where the order is now, in one of the five meanings, and since when. */
export function whereNow(row: OrderRow, t: Translate): { tone: StatusTone; label: string } {
  const days = (Date.now() - new Date(row.stage_since).getTime()) / 86_400_000;

  switch (row.stage) {
    case 'cancelled':
      return { tone: 'closed', label: t('orders.where.cancelled') };
    case 'to_ship':
      // Booked with the courier, the parcel still here until they collect it.
      if (row.fulfillment_status === 'awaiting_pickup') {
        return { tone: 'wait', label: t('orders.where.awaitingPickup', { courier: courierName(row, t) }) };
      }
      return { tone: 'wait', label: t('orders.where.toShip') };
    case 'on_the_road':
      if (row.courier === 'own') {
        return { tone: 'wait', label: t('orders.where.withDriver', { name: courierName(row, t) }) };
      }
      return days >= COURIER_LATE_DAYS
        ? { tone: 'back', label: t('orders.where.late', { courier: courierName(row, t) }) }
        : { tone: 'road', label: t('orders.where.withCourier', { courier: courierName(row, t) }) };
    case 'delivered':
      return { tone: 'done', label: t('orders.where.delivered') };
    default:
      return {
        tone: row.fulfillment_status === 'returned' ? 'closed' : 'back',
        label: t(`fulfillment.${row.fulfillment_status}`),
      };
  }
}
