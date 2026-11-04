/**
 * What the reports compute, from the three report views.
 *
 * Sales are counted the way Shopify counts them (the owner, 2026-10-28):
 * gross on the day ordered, less discounts, less what came back on the day it
 * came back - net sales. Cancelled orders are not in the views at all. Except
 * a refusal at the door (the owner, 2026-11-04): a parcel the customer would
 * not take was never a sale, so it is in neither the sales nor the returns -
 * see leaveOutRefusals.
 *
 * Dates are Cairo `YYYY-MM-DD` strings throughout, compared as strings; the
 * views have already put every row on its Cairo day.
 */

export interface SaleLine {
  line_id: string;
  order_id: string;
  order_number: string;
  placed_on: string;
  channel: string;
  payment_method: string | null;
  governorate: string | null;
  customer_id: string | null;
  product_id: string | null;
  product_title: string;
  variant_id: string | null;
  sku: string;
  size: string | null;
  color: string | null;
  quantity: number;
  gross_egp: number;
  discounts_egp: number;
  net_egp: number;
}

export interface ReturnLine {
  return_line_id: string;
  order_id: string;
  order_number: string;
  returned_on: string;
  return_type: string;
  reason: string | null;
  channel: string;
  governorate: string | null;
  product_id: string | null;
  product_title: string;
  variant_id: string | null;
  sku: string;
  size: string | null;
  color: string | null;
  quantity: number;
  value_egp: number;
}

export interface ReportOrder {
  order_id: string;
  order_number: string;
  placed_on: string;
  channel: string;
  payment_method: string | null;
  governorate: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  is_exchange: boolean;
  net_egp: number;
  units: number;
  courier: string | null;
  outcome: 'delivered' | 'refused' | 'returned' | 'open';
  customer_order_no: number | null;
  /** Where the goods are now. */
  fulfillment_status: string;
  /** What the customer was charged for shipping: not a sale. */
  shipping_egp: number;
  /** Where the money is - 'paid' once it is ours. Read from the order beside the view. */
  payment_status: string | null;
  /** For an exchange's replacement, the order it replaces. Read beside the view too. */
  exchange_for_order_id: string | null;
}

/** Inclusive Cairo dates. */
export interface Range {
  from: string;
  to: string;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const sum = <T>(rows: T[], pick: (row: T) => number) => cents(rows.reduce((total, row) => total + Number(pick(row)), 0));

// --- Dates --------------------------------------------------------------------------------

function toDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return toDay(date);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000) + 1;
}

/** Every day in the range, oldest first. */
export function daysOf(range: Range): string[] {
  const out: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) out.push(day);
  return out;
}

/** The same number of days, ending the day before this range starts. */
export function previousRange(range: Range): Range {
  const length = daysBetween(range.from, range.to);
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

export const within = (day: string, range: Range) => day >= range.from && day <= range.to;

// --- The headline -----------------------------------------------------------------------------

export interface Summary {
  gross: number;
  discounts: number;
  returns: number;
  net: number;
  orders: number;
  units: number;
  unitsReturned: number;
  averageOrder: number;
  /** Of the courier orders placed in the range that have finished: delivered, refused, sent back. */
  delivered: number;
  refused: number;
  returnedAfterDelivery: number;
  deliveryRate: number | null;
  refusalRate: number | null;
}

export function summarize(lines: SaleLine[], returns: ReturnLine[], orders: ReportOrder[], range: Range): Summary {
  const sold = lines.filter((line) => within(line.placed_on, range));
  const back = returns.filter((line) => within(line.returned_on, range));
  const placed = orders.filter((order) => within(order.placed_on, range));

  const gross = sum(sold, (line) => line.gross_egp);
  const discounts = sum(sold, (line) => line.discounts_egp);
  const returned = sum(back, (line) => line.value_egp);
  // An exchange's replacement is not a new order from anyone, and an order
  // refused at the door was never a sale.
  const orderCount = placed.filter((order) => !order.is_exchange && order.outcome !== 'refused').length;

  const shipped = placed.filter((order) => order.courier !== null);
  const delivered = shipped.filter((order) => order.outcome === 'delivered').length;
  const refused = shipped.filter((order) => order.outcome === 'refused').length;
  const returnedAfterDelivery = shipped.filter((order) => order.outcome === 'returned').length;
  const finished = delivered + refused + returnedAfterDelivery;

  return {
    gross,
    discounts,
    returns: returned,
    net: cents(gross - discounts - returned),
    orders: orderCount,
    units: sold.reduce((total, line) => total + line.quantity, 0),
    unitsReturned: back.reduce((total, line) => total + line.quantity, 0),
    averageOrder: orderCount > 0 ? cents((gross - discounts) / orderCount) : 0,
    delivered,
    refused,
    returnedAfterDelivery,
    deliveryRate: finished > 0 ? (delivered + returnedAfterDelivery) / finished : null,
    refusalRate: finished > 0 ? refused / finished : null,
  };
}

// --- Orders still open -------------------------------------------------------------------------

/**
 * Orders placed in the range that have not reached the customer yet - being
 * confirmed or packed, or with the courier. Every report counts them as sold
 * the day they were ordered; this is how much of the range rests on them.
 */
export function openInRange(lines: SaleLine[], orders: ReportOrder[], range: Range) {
  const open = orders.filter((order) => within(order.placed_on, range) && order.outcome === 'open');
  const ids = new Set(open.map((order) => order.order_id));
  return {
    // An exchange's replacement is not a new order from anyone.
    orders: open.filter((order) => !order.is_exchange).length,
    net: sum(
      lines.filter((line) => ids.has(line.order_id)),
      (line) => line.net_egp,
    ),
  };
}

// --- Refusals at the door ------------------------------------------------------------------------

/**
 * The rows without what was refused at the door (the owner, 2026-11-04). A
 * parcel the customer would not take was never a sale: rather than counted
 * sold on the day ordered and taken back as a return when it was refused, its
 * pieces leave the sales and its refusal leaves the returns. Refused in part,
 * only the pieces refused leave; the order stays, worth what was kept.
 *
 * The refusals are kept apart, for the refusals report. A refusal of an order
 * placed before the rows begin has no sale here to take off, and simply
 * leaves the returns - its order's period is where it was never a sale.
 */
export function leaveOutRefusals<D extends { lines: SaleLine[]; returns: ReturnLine[]; orders: ReportOrder[] }>(
  data: D,
): D & { refusals: ReturnLine[] } {
  const refusals = data.returns.filter((line) => line.return_type === 'failed_delivery');
  // Pieces refused, by order and piece - a return line names the piece, not
  // the order line it came from.
  const refused = new Map<string, number>();
  for (const line of refusals) {
    const key = `${line.order_id}|${line.sku}`;
    refused.set(key, (refused.get(key) ?? 0) + line.quantity);
  }

  const offOrder = new Map<string, number>();
  const lines: SaleLine[] = [];
  for (const line of data.lines) {
    const key = `${line.order_id}|${line.sku}`;
    const left = refused.get(key) ?? 0;
    const take = Math.min(left, line.quantity);
    if (take <= 0) {
      lines.push(line);
      continue;
    }
    refused.set(key, left - take);
    const kept = line.quantity - take;
    const gross = cents((Number(line.gross_egp) * kept) / line.quantity);
    const net = cents((Number(line.net_egp) * kept) / line.quantity);
    offOrder.set(line.order_id, cents((offOrder.get(line.order_id) ?? 0) + Number(line.net_egp) - net));
    if (kept > 0) lines.push({ ...line, quantity: kept, gross_egp: gross, discounts_egp: cents(gross - net), net_egp: net });
  }

  return {
    ...data,
    lines,
    returns: data.returns.filter((line) => line.return_type !== 'failed_delivery'),
    orders: data.orders.map((order) => {
      const off = offOrder.get(order.order_id);
      return off ? { ...order, net_egp: cents(Number(order.net_egp) - off) } : order;
    }),
    refusals,
  };
}

/** The same rows without the orders still open: only what reached the customer, or came back. */
export function leaveOutOpen<D extends { lines: SaleLine[]; returns: ReturnLine[]; orders: ReportOrder[] }>(data: D): D {
  const open = new Set(data.orders.filter((order) => order.outcome === 'open').map((order) => order.order_id));
  if (open.size === 0) return data;
  return {
    ...data,
    lines: data.lines.filter((line) => !open.has(line.order_id)),
    returns: data.returns.filter((line) => !open.has(line.order_id)),
    orders: data.orders.filter((order) => !open.has(order.order_id)),
  };
}

/** The change from one period to the next, as a fraction; null when there is nothing to compare with. */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

// --- Over time ---------------------------------------------------------------------------------

export interface DayPoint {
  day: string;
  net: number;
  orders: number;
  units: number;
  gross: number;
  discounts: number;
  returns: number;
}

/** Each day of the range: what sold, less what came back that day. */
export function byDay(lines: SaleLine[], returns: ReturnLine[], orders: ReportOrder[], range: Range): DayPoint[] {
  const points = new Map<string, DayPoint>(
    daysOf(range).map((day) => [day, { day, net: 0, orders: 0, units: 0, gross: 0, discounts: 0, returns: 0 }]),
  );
  for (const line of lines) {
    const point = points.get(line.placed_on);
    if (!point) continue;
    point.gross += Number(line.gross_egp);
    point.discounts += Number(line.discounts_egp);
    point.units += line.quantity;
  }
  for (const line of returns) {
    const point = points.get(line.returned_on);
    if (point) point.returns += Number(line.value_egp);
  }
  for (const order of orders) {
    const point = points.get(order.placed_on);
    if (point && !order.is_exchange && order.outcome !== 'refused') point.orders += 1;
  }
  return [...points.values()].map((point) => ({
    ...point,
    gross: cents(point.gross),
    discounts: cents(point.discounts),
    returns: cents(point.returns),
    net: cents(point.gross - point.discounts - point.returns),
  }));
}

/** Days rolled into weeks (starting on the range's first day) or calendar months. */
export function rollUp(points: DayPoint[], by: 'day' | 'week' | 'month'): DayPoint[] {
  if (by === 'day') return points;
  const groups = new Map<string, DayPoint>();
  points.forEach((point, index) => {
    const key = by === 'month' ? point.day.slice(0, 7) : points[index - (index % 7)]!.day;
    const group = groups.get(key) ?? { day: key, net: 0, orders: 0, units: 0, gross: 0, discounts: 0, returns: 0 };
    group.net += point.net;
    group.orders += point.orders;
    group.units += point.units;
    group.gross += point.gross;
    group.discounts += point.discounts;
    group.returns += point.returns;
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    net: cents(group.net),
    gross: cents(group.gross),
    discounts: cents(group.discounts),
    returns: cents(group.returns),
  }));
}

// --- What sold ---------------------------------------------------------------------------------

export interface ItemRow {
  key: string;
  label: string;
  /** Size and colour, for a variant row. */
  detail: string | null;
  sku: string | null;
  units: number;
  unitsReturned: number;
  gross: number;
  net: number;
  /** Of the pieces sold in the range, the share that came back in it. */
  returnRate: number | null;
}

function groupItems(
  lines: SaleLine[],
  returns: ReturnLine[],
  range: Range,
  keyOf: (row: SaleLine | ReturnLine) => string,
  describe: (row: SaleLine | ReturnLine) => Pick<ItemRow, 'label' | 'detail' | 'sku'>,
): ItemRow[] {
  const rows = new Map<string, ItemRow>();
  const rowFor = (source: SaleLine | ReturnLine) => {
    const key = keyOf(source);
    let row = rows.get(key);
    if (!row) {
      row = { key, ...describe(source), units: 0, unitsReturned: 0, gross: 0, net: 0, returnRate: null };
      rows.set(key, row);
    }
    return row;
  };
  for (const line of lines) {
    if (!within(line.placed_on, range)) continue;
    const row = rowFor(line);
    row.units += line.quantity;
    row.gross += Number(line.gross_egp);
    row.net += Number(line.net_egp);
  }
  for (const line of returns) {
    if (!within(line.returned_on, range)) continue;
    const row = rowFor(line);
    row.unitsReturned += line.quantity;
    row.net -= Number(line.value_egp);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      gross: cents(row.gross),
      net: cents(row.net),
      returnRate: row.units > 0 ? row.unitsReturned / row.units : null,
    }))
    .sort((a, b) => b.net - a.net || b.units - a.units);
}

export function byProduct(lines: SaleLine[], returns: ReturnLine[], range: Range): ItemRow[] {
  return groupItems(
    lines,
    returns,
    range,
    (row) => row.product_id ?? row.product_title,
    (row) => ({ label: row.product_title, detail: null, sku: null }),
  );
}

export function byVariant(lines: SaleLine[], returns: ReturnLine[], range: Range): ItemRow[] {
  return groupItems(
    lines,
    returns,
    range,
    (row) => row.variant_id ?? row.sku,
    (row) => ({
      label: row.product_title,
      detail: [row.size, row.color].filter(Boolean).join(' / ') || null,
      sku: row.sku,
    }),
  );
}

/** Pieces by size across every product - which sizes to make more of. */
export function bySize(lines: SaleLine[], returns: ReturnLine[], range: Range): ItemRow[] {
  return groupItems(
    lines,
    returns,
    range,
    (row) => (row.size ?? '—').toUpperCase(),
    (row) => ({ label: (row.size ?? '—').toUpperCase(), detail: null, sku: null }),
  ).sort((a, b) => b.units - a.units);
}

/** Pieces by colour across every product. */
export function byColor(lines: SaleLine[], returns: ReturnLine[], range: Range): ItemRow[] {
  return groupItems(
    lines,
    returns,
    range,
    (row) => (row.color ?? '—').toLowerCase(),
    (row) => ({ label: row.color ?? '—', detail: null, sku: null }),
  ).sort((a, b) => b.units - a.units);
}

// --- Where from, and how it ended ----------------------------------------------------------------

export interface GroupRow {
  key: string;
  orders: number;
  /** Ordered value, after discounts, of the orders placed in the range - less what was refused at the door. */
  value: number;
  averageOrder: number;
  delivered: number;
  refused: number;
  returnedAfterDelivery: number;
  open: number;
  refusalRate: number | null;
}

function groupOrders(orders: ReportOrder[], range: Range, keyOf: (order: ReportOrder) => string): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  for (const order of orders) {
    if (!within(order.placed_on, range) || order.is_exchange) continue;
    const key = keyOf(order);
    const row = rows.get(key) ?? {
      key,
      orders: 0,
      value: 0,
      averageOrder: 0,
      delivered: 0,
      refused: 0,
      returnedAfterDelivery: 0,
      open: 0,
      refusalRate: null,
    };
    row.orders += 1;
    row.value += Number(order.net_egp);
    if (order.outcome === 'delivered') row.delivered += 1;
    else if (order.outcome === 'refused') row.refused += 1;
    else if (order.outcome === 'returned') row.returnedAfterDelivery += 1;
    else row.open += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => {
      const finished = row.delivered + row.refused + row.returnedAfterDelivery;
      // An order refused at the door is worth nothing in the value, and is
      // not an order in its average.
      const sold = row.orders - row.refused;
      return {
        ...row,
        value: cents(row.value),
        averageOrder: sold > 0 ? cents(row.value / sold) : 0,
        refusalRate: finished > 0 ? row.refused / finished : null,
      };
    })
    .sort((a, b) => b.orders - a.orders || b.value - a.value);
}

export const byGovernorate = (orders: ReportOrder[], range: Range) =>
  groupOrders(orders, range, (order) => order.governorate?.trim() || '—');

export const byChannel = (orders: ReportOrder[], range: Range) => groupOrders(orders, range, (order) => order.channel);

export const byPayment = (orders: ReportOrder[], range: Range) =>
  groupOrders(orders, range, (order) => order.payment_method ?? '—');

/** What came back in the range, by why. */
export function returnsByReason(returns: ReturnLine[], range: Range) {
  const rows = new Map<string, { key: string; type: string; orders: Set<string>; pieces: number; value: number }>();
  for (const line of returns) {
    if (!within(line.returned_on, range)) continue;
    const key = `${line.return_type}:${line.reason ?? ''}`;
    const row = rows.get(key) ?? { key, type: line.return_type, orders: new Set<string>(), pieces: 0, value: 0 };
    row.orders.add(line.order_id);
    row.pieces += line.quantity;
    row.value += Number(line.value_egp);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      type: row.type,
      reason: row.key.split(':')[1] || null,
      orders: row.orders.size,
      pieces: row.pieces,
      value: cents(row.value),
    }))
    .sort((a, b) => b.orders - a.orders);
}

// --- Customers -----------------------------------------------------------------------------------

export function customers(orders: ReportOrder[], range: Range) {
  const placed = orders.filter((order) => within(order.placed_on, range) && !order.is_exchange && order.customer_id);
  const first = placed.filter((order) => order.customer_order_no === 1);
  const again = placed.filter((order) => (order.customer_order_no ?? 0) > 1);

  const top = new Map<string, { key: string; name: string | null; phone: string | null; orders: number; value: number }>();
  for (const order of placed) {
    const key = order.customer_id as string;
    const row = top.get(key) ?? { key, name: order.customer_name, phone: order.customer_phone, orders: 0, value: 0 };
    row.orders += 1;
    row.value += Number(order.net_egp);
    top.set(key, row);
  }

  return {
    newCustomers: new Set(first.map((order) => order.customer_id)).size,
    returningCustomers: new Set(again.map((order) => order.customer_id)).size,
    newValue: sum(first, (order) => order.net_egp),
    returningValue: sum(again, (order) => order.net_egp),
    top: [...top.values()]
      .map((row) => ({ ...row, value: cents(row.value) }))
      .sort((a, b) => b.value - a.value || b.orders - a.orders),
  };
}

// --- Stock -----------------------------------------------------------------------------------------

export interface StockItem {
  variant_id: string;
  sku: string;
  product_title: string;
  size: string | null;
  color: string | null;
  quantity: number;
}

export interface StockHealthRow extends StockItem {
  /** Sold in the last 30 days, less what came back. */
  sold: number;
  /** Days the shelf lasts at that pace; null when nothing is selling. */
  cover: number | null;
  state: 'out' | 'low' | 'slow' | 'ok';
}

/**
 * How each piece is doing at the pace of the last 30 days: run out while still
 * selling, under two weeks left, sitting unsold, or fine.
 */
export function stockHealth(stock: StockItem[], lines: SaleLine[], returns: ReturnLine[], today: string): StockHealthRow[] {
  const window: Range = { from: addDays(today, -29), to: today };
  const sold = new Map<string, number>();
  for (const line of lines) {
    if (line.variant_id && within(line.placed_on, window)) {
      sold.set(line.variant_id, (sold.get(line.variant_id) ?? 0) + line.quantity);
    }
  }
  for (const line of returns) {
    if (line.variant_id && within(line.returned_on, window)) {
      sold.set(line.variant_id, (sold.get(line.variant_id) ?? 0) - line.quantity);
    }
  }

  return stock
    .map((item) => {
      const units = Math.max(0, sold.get(item.variant_id) ?? 0);
      const perDay = units / 30;
      const cover = perDay > 0 ? Math.floor(Math.max(0, item.quantity) / perDay) : null;
      const state: StockHealthRow['state'] =
        item.quantity <= 0 ? (units > 0 ? 'out' : 'ok') : cover !== null && cover < 14 ? 'low' : units === 0 ? 'slow' : 'ok';
      return { ...item, sold: units, cover, state };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.sold - a.sold || b.quantity - a.quantity);
}

const STATE_ORDER: Record<StockHealthRow['state'], number> = { out: 0, low: 1, slow: 2, ok: 3 };

// --- Money ---------------------------------------------------------------------------------------

/** One transfer or payment that came in, or a refund paid back (negative) - v_report_money_in. */
export interface MoneyInRow {
  source: 'courier_transfer' | 'shop' | 'own_driver' | 'paid_before_shipping' | 'courier_by_hand' | 'refund';
  received_on: string;
  ref_id: string;
  label: string | null;
  order_id: string | null;
  amount_egp: number;
}

/** A parcel whose cash a courier or our driver holds, or is out to collect - v_money_with_couriers. */
export interface CourierMoneyRow {
  shipment_id: string;
  order_id: string;
  order_number: string;
  courier: string;
  tracking_number: string | null;
  driver_name: string | null;
  state: 'collected' | 'out';
  amount_egp: number;
  days: number;
  customer_name: string | null;
}

export const MONEY_SOURCES: MoneyInRow['source'][] = [
  'courier_transfer',
  'own_driver',
  'shop',
  'paid_before_shipping',
  'courier_by_hand',
  'refund',
];

/** What came in during the range, by where from, and the total after refunds. */
export function moneyIn(rows: MoneyInRow[], range: Range) {
  const inRange = rows.filter((row) => within(row.received_on, range));
  const bySource = MONEY_SOURCES.map((source) => {
    const of = inRange.filter((row) => row.source === source);
    return { source, count: of.length, amount: sum(of, (row) => row.amount_egp) };
  }).filter((row) => row.count > 0);
  return { rows: inRange, bySource, total: sum(inRange, (row) => row.amount_egp) };
}

/**
 * What the couriers hold now: collected by Accurate and not paid over yet,
 * still out with Accurate, out with our drivers.
 */
export function moneyWithCouriers(rows: CourierMoneyRow[]) {
  const part = (keep: (row: CourierMoneyRow) => boolean) => {
    const of = rows.filter(keep);
    return { count: of.length, amount: sum(of, (row) => row.amount_egp) };
  };
  return {
    collected: part((row) => row.state === 'collected'),
    out: part((row) => row.state === 'out' && row.courier !== 'own'),
    ownOut: part((row) => row.state === 'out' && row.courier === 'own'),
    total: sum(rows, (row) => row.amount_egp),
  };
}

// --- Completed sales ---------------------------------------------------------------------------------

/**
 * Where an order placed in the range stands now. It is complete once it
 * reached the customer and its money is ours (the owner, 2026-11-04):
 * Accurate's statement reviewed, our driver's cash in, paid in the shop or
 * before it shipped - payment_status 'paid', which nothing else sets.
 */
export type Standing = 'completed' | 'awaitingMoney' | 'onTheRoad' | 'notShipped' | 'cameBack';

/** Not complete yet, but on the way to it - the furthest along first. */
export const WAITING = ['awaitingMoney', 'onTheRoad', 'notShipped'] as const satisfies readonly Standing[];

const ON_THE_ROAD = new Set(['awaiting_pickup', 'in_transit', 'out_for_delivery']);
const CAME_BACK = new Set(['delivery_failed', 'return_in_transit', 'returned']);
const MONEY_IN = new Set(['paid', 'partially_refunded']);

export interface StandingOrder {
  /** The order holding it up: the sale itself, or the replacement still out. */
  order_id: string;
  order_number: string;
  placed_on: string;
  /** For a replacement, the order the sale was placed as. */
  replaces: string | null;
  customer_name: string | null;
  courier: string | null;
  fulfillment_status: string;
  standing: Standing;
  /** The pieces the customer has, or will: less what was refused or sent back. */
  pieces: number;
  /** Their goods, after discounts. */
  net: number;
}

export interface CompletedItem {
  key: string;
  label: string;
  /** Size and colour for a variant; the colour, if the product has one, for an item. */
  detail: string | null;
  sku: string | null;
  pieces: number;
  net: number;
}

/**
 * The month as the owner counts it (2026-11-04): the sales placed in the
 * range, by order date, that are complete - their goods after discounts, less
 * every piece refused at the door or sent back after delivery, whenever it
 * came back; shipping apart, as it is no sale. What is not complete yet is
 * counted beside it, so the range adds up: complete, still to come, or back.
 *
 * An exchange is the sale it was placed as, not a new order from anyone: its
 * replacement - and a replacement's replacement - belongs to the order the
 * customer placed, in that order's month. The sale is complete when the piece
 * the customer ends up with is delivered and paid for: #1481, ordered in
 * October, swapped once and then again, is October's, on the road until
 * W2611-00069 arrives. The old piece is off at what it sold for and the new
 * one on at its own price (the reports' way, 20261104130000).
 *
 * Read off rows without the refusals at the door (leaveOutRefusals). A past
 * range keeps growing while its statements come in.
 */
export function completedSales(lines: SaleLine[], returns: ReturnLine[], orders: ReportOrder[], range: Range) {
  const byId = new Map(orders.map((order) => [order.order_id, order]));
  // The order a sale was placed as. One whose original is not in the rows was
  // placed before them, so before the range.
  const rootOf = (order: ReportOrder): ReportOrder | null => {
    let at = order;
    for (let hops = 0; at.exchange_for_order_id && hops < 20; hops += 1) {
      const parent = byId.get(at.exchange_for_order_id);
      if (!parent) return null;
      at = parent;
    }
    return at;
  };
  const sales = new Map<string, { root: ReportOrder; members: ReportOrder[] }>();
  for (const order of orders) {
    const root = rootOf(order);
    if (!root || !within(root.placed_on, range)) continue;
    const sale = sales.get(root.order_id) ?? { root, members: [] };
    sale.members.push(order);
    sales.set(root.order_id, sale);
  }
  const ids = new Set([...sales.values()].flatMap((sale) => sale.members.map((order) => order.order_id)));

  // Pieces back, by order and piece - a return line names the piece, not the order line.
  const back = new Map<string, number>();
  for (const line of returns) {
    if (!ids.has(line.order_id)) continue;
    const key = `${line.order_id}|${line.sku}`;
    back.set(key, (back.get(key) ?? 0) + line.quantity);
  }

  // Each order's lines, less what came back of them.
  const kept = new Map<string, Array<{ line: SaleLine; pieces: number; net: number }>>();
  for (const line of lines) {
    if (!ids.has(line.order_id) || line.quantity <= 0) continue;
    const key = `${line.order_id}|${line.sku}`;
    const left = back.get(key) ?? 0;
    const take = Math.min(left, line.quantity);
    if (take > 0) back.set(key, left - take);
    const pieces = line.quantity - take;
    const net = take > 0 ? cents((Number(line.net_egp) * pieces) / line.quantity) : Number(line.net_egp);
    const list = kept.get(line.order_id) ?? [];
    list.push({ line, pieces, net });
    kept.set(line.order_id, list);
  }
  const piecesOf = (order: ReportOrder) => (kept.get(order.order_id) ?? []).reduce((total, entry) => total + entry.pieces, 0);
  const netOf = (order: ReportOrder) => sum(kept.get(order.order_id) ?? [], (entry) => entry.net);

  const standingOf = (order: ReportOrder): Standing => {
    if (piecesOf(order) <= 0 || CAME_BACK.has(order.fulfillment_status) || order.payment_status === 'refunded') return 'cameBack';
    if (order.fulfillment_status === 'delivered') return MONEY_IN.has(order.payment_status ?? '') ? 'completed' : 'awaitingMoney';
    return ON_THE_ROAD.has(order.fulfillment_status) ? 'onTheRoad' : 'notShipped';
  };

  // A sale stands where the least advanced of its orders still holding pieces stands.
  const rank: Standing[] = ['notShipped', 'onTheRoad', 'awaitingMoney', 'completed'];
  const standings = [...sales.values()].map(({ root, members }) => {
    const holding = members.filter((order) => standingOf(order) !== 'cameBack');
    const behind = [...holding].sort(
      (a, b) => rank.indexOf(standingOf(a)) - rank.indexOf(standingOf(b)) || a.placed_on.localeCompare(b.placed_on),
    )[0];
    const at = behind ?? root;
    const row: StandingOrder = {
      order_id: at.order_id,
      order_number: at.order_number,
      placed_on: at.placed_on,
      replaces: at.order_id === root.order_id ? null : root.order_number,
      customer_name: root.customer_name,
      courier: at.courier,
      fulfillment_status: at.fulfillment_status,
      standing: behind ? standingOf(behind) : 'cameBack',
      pieces: holding.reduce((total, order) => total + piecesOf(order), 0),
      net: sum(holding, netOf),
    };
    return { row, holding, members };
  });

  const completed = standings.filter((sale) => sale.row.standing === 'completed');
  const byStanding = Object.fromEntries(
    (['completed', ...WAITING, 'cameBack'] as const).map((standing) => {
      const of = standings.filter((sale) => sale.row.standing === standing).map((sale) => sale.row);
      return [standing, { orders: of.length, pieces: of.reduce((total, row) => total + row.pieces, 0), net: sum(of, (row) => row.net) }];
    }),
  ) as Record<Standing, { orders: number; pieces: number; net: number }>;

  // What the completed sales sold, by variant and by item (the product, in its colour).
  const variants = new Map<string, CompletedItem>();
  const items = new Map<string, CompletedItem>();
  const add = (into: Map<string, CompletedItem>, key: string, make: () => Omit<CompletedItem, 'pieces' | 'net'>, pieces: number, net: number) => {
    const row = into.get(key) ?? { ...make(), pieces: 0, net: 0 };
    row.pieces += pieces;
    row.net += net;
    into.set(key, row);
  };
  for (const { holding } of completed) {
    for (const order of holding) {
      for (const { line, pieces, net } of kept.get(order.order_id) ?? []) {
        if (pieces <= 0) continue;
        const variantKey = line.variant_id ?? line.sku;
        add(
          variants,
          variantKey,
          () => ({ key: variantKey, label: line.product_title, detail: [line.size, line.color].filter(Boolean).join(' / ') || null, sku: line.sku }),
          pieces,
          net,
        );
        const itemKey = `${line.product_id ?? line.product_title}|${line.color ?? ''}`;
        add(items, itemKey, () => ({ key: itemKey, label: line.product_title, detail: line.color, sku: null }), pieces, net);
      }
    }
  }
  const ranked = (rows: Map<string, CompletedItem>) =>
    [...rows.values()]
      .map((row) => ({ ...row, net: cents(row.net) }))
      .sort((a, b) => b.pieces - a.pieces || b.net - a.net || a.label.localeCompare(b.label));

  const net = byStanding.completed.net;
  return {
    net,
    // Every time the customer paid for shipping on the sale: an exchange went out twice.
    shipping: sum(
      completed.flatMap((sale) => sale.members),
      (order) => (order.fulfillment_status === 'delivered' && MONEY_IN.has(order.payment_status ?? '') ? Number(order.shipping_egp ?? 0) : 0),
    ),
    orders: completed.length,
    pieces: byStanding.completed.pieces,
    averageOrder: completed.length > 0 ? cents(net / completed.length) : 0,
    /** Sales placed in the range: an exchange's replacements are not more of them. */
    placed: standings.length,
    byStanding,
    /** Still to complete, oldest first. */
    waiting: standings
      .map((sale) => sale.row)
      .filter((row) => row.standing !== 'completed' && row.standing !== 'cameBack')
      .sort((a, b) => a.placed_on.localeCompare(b.placed_on) || a.order_number.localeCompare(b.order_number)),
    variants: ranked(variants),
    items: ranked(items),
  };
}

// --- Download ----------------------------------------------------------------------------------------

type CsvRow = Array<string | number | null>;

const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvLines = (rows: CsvRow[]) => rows.map((row) => row.map(csvCell).join(','));

/** A table as CSV, quoted where it must be, with a BOM so Excel reads the Arabic. */
export function toCsv(header: string[], rows: CsvRow[]): string {
  return `﻿${csvLines([header, ...rows]).join('\r\n')}`;
}

/**
 * Several tables in one sheet, one under the other: what a report put
 * together by hand downloads as. Each starts with its title and is set off
 * by an empty line.
 */
export function toCsvSections(preface: CsvRow[], sections: Array<{ title: string; header: string[]; rows: CsvRow[] }>): string {
  const blocks = [
    csvLines(preface),
    ...sections.map((section) => csvLines([[section.title], section.header, ...section.rows])),
  ].filter((block) => block.length > 0);
  return `﻿${blocks.map((block) => block.join('\r\n')).join('\r\n\r\n')}`;
}
