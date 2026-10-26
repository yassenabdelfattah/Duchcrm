/**
 * What the reports compute, from the three report views.
 *
 * Sales are counted the way Shopify counts them (the owner, 2026-10-28):
 * gross on the day ordered, less discounts, less what came back on the day it
 * came back - net sales. Cancelled orders are not in the views at all.
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
  // An exchange's replacement is not a new order from anyone.
  const orderCount = placed.filter((order) => !order.is_exchange).length;

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
    if (point && !order.is_exchange) point.orders += 1;
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
  /** Ordered value, after discounts, of the orders placed in the range. */
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
      return {
        ...row,
        value: cents(row.value),
        averageOrder: row.orders > 0 ? cents(row.value / row.orders) : 0,
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

// --- Download ----------------------------------------------------------------------------------------

/** A table as CSV, quoted where it must be, with a BOM so Excel reads the Arabic. */
export function toCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}`;
}
