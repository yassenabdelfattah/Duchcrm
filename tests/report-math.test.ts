import { describe, expect, it } from 'vitest';
import {
  byDay,
  byGovernorate,
  byProduct,
  bySize,
  change,
  completedSales,
  customers,
  leaveOutOpen,
  leaveOutRefusals,
  moneyIn,
  moneyWithCouriers,
  openInRange,
  previousRange,
  rollUp,
  stockHealth,
  summarize,
  toCsv,
  toCsvSections,
  type CourierMoneyRow,
  type MoneyInRow,
  type ReportOrder,
  type ReturnLine,
  type SaleLine,
} from '../apps/dashboard/src/lib/reportMath';

const sale = (fields: Partial<SaleLine>): SaleLine => ({
  line_id: 'l',
  order_id: 'o',
  order_number: '#1',
  placed_on: '2026-10-20',
  channel: 'online',
  payment_method: 'cod',
  governorate: 'Cairo',
  customer_id: 'c',
  product_id: 'hoodie',
  product_title: 'Hoodie',
  variant_id: 'hoodie-m',
  sku: 'H-M',
  size: 'M',
  color: 'Black',
  quantity: 1,
  gross_egp: 1000,
  discounts_egp: 0,
  net_egp: 1000,
  ...fields,
});

const back = (fields: Partial<ReturnLine>): ReturnLine => ({
  return_line_id: 'r',
  order_id: 'o',
  order_number: '#1',
  returned_on: '2026-10-22',
  return_type: 'failed_delivery',
  reason: 'refused_unopened',
  channel: 'online',
  governorate: 'Cairo',
  product_id: 'hoodie',
  product_title: 'Hoodie',
  variant_id: 'hoodie-m',
  sku: 'H-M',
  size: 'M',
  color: 'Black',
  quantity: 1,
  value_egp: 1000,
  ...fields,
});

const order = (fields: Partial<ReportOrder>): ReportOrder => ({
  order_id: 'o',
  order_number: '#1',
  placed_on: '2026-10-20',
  channel: 'online',
  payment_method: 'cod',
  governorate: 'Cairo',
  customer_id: 'c',
  customer_name: 'Mona',
  customer_phone: null,
  is_exchange: false,
  net_egp: 1000,
  units: 1,
  courier: 'accurate',
  outcome: 'delivered',
  customer_order_no: 1,
  fulfillment_status: 'delivered',
  shipping_egp: 0,
  payment_status: 'paid',
  exchange_for_order_id: null,
  ...fields,
});

const week = { from: '2026-10-20', to: '2026-10-26' };

// Three orders: a hoodie delivered, a hoodie with 100 off refused at the door
// (back on the 22nd), and two shirts in the shop, one brought back on the 23rd.
const lines = [
  sale({ order_id: 'a' }),
  sale({ order_id: 'b', discounts_egp: 100, net_egp: 900, placed_on: '2026-10-21' }),
  sale({ order_id: 'c', product_id: 'shirt', product_title: 'Shirt', variant_id: 'shirt-l', sku: 'S-L', size: 'l', quantity: 2, gross_egp: 1000, net_egp: 1000, channel: 'store' }),
];
const returns = [
  back({ order_id: 'b', value_egp: 900 }),
  back({
    order_id: 'c',
    return_type: 'post_delivery',
    reason: 'wrong_size',
    returned_on: '2026-10-23',
    product_id: 'shirt',
    product_title: 'Shirt',
    variant_id: 'shirt-l',
    sku: 'S-L',
    size: 'l',
    value_egp: 500,
  }),
];
const orders = [
  order({ order_id: 'a', customer_id: 'mona', customer_order_no: 1 }),
  order({ order_id: 'b', placed_on: '2026-10-21', net_egp: 900, outcome: 'refused', governorate: 'Giza', customer_id: 'ali', customer_name: 'Ali' }),
  order({ order_id: 'c', channel: 'store', courier: null, net_egp: 1000, units: 2, customer_id: 'mona', customer_order_no: 2 }),
];
// As every report reads them: the refusal at the door is neither sold nor back.
const sold = leaveOutRefusals({ lines, returns, orders });

describe('dates', () => {
  it('compares a week with the week before it', () => {
    expect(previousRange(week)).toEqual({ from: '2026-10-13', to: '2026-10-19' });
  });

  it('compares a month with the same number of days before it', () => {
    expect(previousRange({ from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-08-31', to: '2026-09-30' });
  });
});

describe('refusals at the door', () => {
  it('are neither sales nor returns: the refused order leaves both, and is worth nothing', () => {
    expect(sold.lines.map((line) => line.order_id)).toEqual(['a', 'c']);
    expect(sold.returns.map((line) => line.order_id)).toEqual(['c']);
    expect(sold.orders.find((row) => row.order_id === 'b')).toMatchObject({ net_egp: 0, outcome: 'refused' });
    expect(sold.refusals).toHaveLength(1);
  });

  it('take off only the pieces refused when the customer kept the rest', () => {
    const two = sale({ order_id: 'e', quantity: 2, gross_egp: 2000, discounts_egp: 200, net_egp: 1800 });
    const result = leaveOutRefusals({
      lines: [two],
      returns: [back({ order_id: 'e', value_egp: 900 })],
      orders: [order({ order_id: 'e', net_egp: 1800, units: 2 })],
    });
    expect(result.lines).toEqual([{ ...two, quantity: 1, gross_egp: 1000, discounts_egp: 100, net_egp: 900 }]);
    expect(result.orders[0]!.net_egp).toBe(900);
  });

  it('leave the returns without taking anything off when the order was placed before the rows', () => {
    const result = leaveOutRefusals({ lines, returns: [back({ order_id: 'old' })], orders });
    expect(result.lines).toEqual(lines);
    expect(result.returns).toEqual([]);
  });
});

describe('summarize', () => {
  const summary = summarize(sold.lines, sold.returns, sold.orders, week);

  it('counts sales the Shopify way: gross, less discounts, less what came back - never a refusal', () => {
    expect(summary.gross).toBe(2000);
    expect(summary.discounts).toBe(0);
    expect(summary.returns).toBe(500);
    expect(summary.net).toBe(1500);
  });

  it('averages an order before returns, as Shopify does, and a refused order is no order', () => {
    expect(summary.orders).toBe(2);
    expect(summary.averageOrder).toBe(1000);
  });

  it('rates delivery only on courier orders that have finished', () => {
    expect(summary.delivered).toBe(1);
    expect(summary.refused).toBe(1);
    expect(summary.deliveryRate).toBe(0.5);
    expect(summary.refusalRate).toBe(0.5);
  });

  it('takes a return off the period it came back in, not the one it was sold in', () => {
    expect(summarize(sold.lines, sold.returns, sold.orders, { from: '2026-10-20', to: '2026-10-22' }).returns).toBe(0);
  });
});

describe('orders still open', () => {
  // A fourth order, still with the courier.
  const withOpen = {
    lines: [...sold.lines, sale({ order_id: 'd', placed_on: '2026-10-25', net_egp: 1400, gross_egp: 1400 })],
    returns: sold.returns,
    orders: [...sold.orders, order({ order_id: 'd', placed_on: '2026-10-25', net_egp: 1400, outcome: 'open' })],
  };

  it('says how much of the range rests on orders not yet with the customer', () => {
    expect(openInRange(withOpen.lines, withOpen.orders, week)).toEqual({ orders: 1, net: 1400 });
    expect(openInRange(withOpen.lines, withOpen.orders, { from: '2026-10-20', to: '2026-10-24' })).toEqual({ orders: 0, net: 0 });
  });

  it('counts them as sold, unless they are left out', () => {
    expect(summarize(withOpen.lines, withOpen.returns, withOpen.orders, week).net).toBe(2900);
    const firm = leaveOutOpen(withOpen);
    expect(summarize(firm.lines, firm.returns, firm.orders, week).net).toBe(1500);
    expect(summarize(firm.lines, firm.returns, firm.orders, week).orders).toBe(2);
  });

  it('leaves the rows alone when nothing is open', () => {
    const data = { lines, returns, orders };
    expect(leaveOutOpen(data)).toBe(data);
  });
});

describe('change', () => {
  it('is a fraction of the previous period, and unknown from nothing', () => {
    expect(change(150, 100)).toBe(0.5);
    expect(change(50, 100)).toBe(-0.5);
    expect(change(10, 0)).toBeNull();
    expect(change(0, 0)).toBe(0);
  });
});

describe('over time', () => {
  it('puts each sale on its day and each return on the day it came back', () => {
    const days = byDay(sold.lines, sold.returns, sold.orders, week);
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ day: '2026-10-20', net: 2000, orders: 2, units: 3 });
    expect(days[1]).toMatchObject({ day: '2026-10-21', net: 0, orders: 0 });
    expect(days[3]).toMatchObject({ day: '2026-10-23', net: -500, returns: 500 });
  });

  it('rolls days into weeks that add up', () => {
    const [onlyWeek] = rollUp(byDay(sold.lines, sold.returns, sold.orders, week), 'week');
    expect(onlyWeek).toMatchObject({ day: '2026-10-20', net: 1500, orders: 2, units: 3 });
  });
});

describe('what sold', () => {
  it('totals each product, with what came back taken off', () => {
    const rows = byProduct(sold.lines, sold.returns, week);
    expect(rows.find((row) => row.label === 'Shirt')).toMatchObject({ units: 2, unitsReturned: 1, net: 500, returnRate: 0.5 });
    expect(rows.find((row) => row.label === 'Hoodie')).toMatchObject({ units: 1, unitsReturned: 0, net: 1000, returnRate: 0 });
  });

  it('ranks by net sales', () => {
    const rows = byProduct([...sold.lines, sale({ order_id: 'd', placed_on: '2026-10-23' })], sold.returns, week);
    expect(rows.map((row) => row.label)).toEqual(['Hoodie', 'Shirt']);
  });

  it('adds sizes up across products whatever their case', () => {
    const sizes = bySize(sold.lines, sold.returns, week);
    expect(sizes.map((row) => [row.label, row.units])).toEqual([
      ['L', 2],
      ['M', 1],
    ]);
  });
});

describe('where from', () => {
  it('rates refusals by governorate, and values only what was not refused', () => {
    const rows = byGovernorate(sold.orders, week);
    expect(rows.find((row) => row.key === 'Giza')).toMatchObject({ orders: 1, refused: 1, refusalRate: 1, value: 0, averageOrder: 0 });
    expect(rows.find((row) => row.key === 'Cairo')).toMatchObject({ orders: 2, delivered: 2, refusalRate: 0, value: 2000, averageOrder: 1000 });
  });
});

describe('customers', () => {
  it('tells a first order from a returning customer, and ranks who spent most', () => {
    const result = customers(sold.orders, week);
    expect(result.newCustomers).toBe(2);
    expect(result.returningCustomers).toBe(1);
    expect(result.top[0]).toMatchObject({ name: 'Mona', orders: 2, value: 2000 });
  });
});

describe('stockHealth', () => {
  const stock = [
    { variant_id: 'hoodie-m', sku: 'H-M', product_title: 'Hoodie', size: 'M', color: 'Black', quantity: 0 },
    { variant_id: 'shirt-l', sku: 'S-L', product_title: 'Shirt', size: 'L', color: null, quantity: 10 },
    { variant_id: 'cap', sku: 'C', product_title: 'Cap', size: null, color: null, quantity: 5 },
    { variant_id: 'bag', sku: 'B', product_title: 'Bag', size: null, color: null, quantity: 500 },
  ];
  const selling = [
    sale({ variant_id: 'hoodie-m', quantity: 3, placed_on: '2026-10-25' }),
    sale({ variant_id: 'shirt-l', quantity: 30, placed_on: '2026-10-25' }),
    sale({ variant_id: 'bag', quantity: 30, placed_on: '2026-10-25' }),
  ];
  const rows = stockHealth(stock, selling, [], '2026-10-26');
  const state = (id: string) => rows.find((row) => row.variant_id === id);

  it('flags what ran out while selling, what has under two weeks left, and what sits unsold', () => {
    expect(state('hoodie-m')).toMatchObject({ state: 'out', sold: 3 });
    expect(state('shirt-l')).toMatchObject({ state: 'low', cover: 10 });
    expect(state('cap')).toMatchObject({ state: 'slow', sold: 0, cover: null });
    expect(state('bag')).toMatchObject({ state: 'ok', cover: 500 });
  });

  it('lists the urgent first', () => {
    expect(rows.map((row) => row.state)).toEqual(['out', 'low', 'slow', 'ok']);
  });
});

describe('money', () => {
  const paid = (source: MoneyInRow['source'], received_on: string, amount_egp: number): MoneyInRow => ({
    source, received_on, amount_egp, ref_id: `${source}-${received_on}-${amount_egp}`, label: null, order_id: null,
  });

  it('adds up what came in during the range by where it came from, refunds off the total', () => {
    const result = moneyIn(
      [paid('courier_transfer', '2026-10-28', 12542), paid('shop', '2026-10-20', 550), paid('shop', '2026-10-21', 1500),
       paid('refund', '2026-10-25', -550), paid('courier_transfer', '2026-11-02', 26830)],
      { from: '2026-10-01', to: '2026-10-31' },
    );
    expect(result.bySource).toEqual([
      { source: 'courier_transfer', count: 1, amount: 12542 },
      { source: 'shop', count: 2, amount: 2050 },
      { source: 'refund', count: 1, amount: -550 },
    ]);
    expect(result.total).toBe(14042);
  });

  it('splits what the couriers hold into collected, still out with them, and out with our drivers', () => {
    const parcel = (courier: string, state: CourierMoneyRow['state'], amount_egp: number): CourierMoneyRow => ({
      shipment_id: `${courier}-${state}-${amount_egp}`, order_id: 'o', order_number: '#1', courier, tracking_number: null,
      driver_name: null, state, amount_egp, days: 1, customer_name: null,
    });
    const result = moneyWithCouriers([parcel('accurate', 'collected', 630), parcel('accurate', 'collected', 1580),
      parcel('accurate', 'out', 780), parcel('own', 'out', 600)]);
    expect(result).toEqual({
      collected: { count: 2, amount: 2210 },
      out: { count: 1, amount: 780 },
      ownOut: { count: 1, amount: 600 },
      total: 3590,
    });
  });
});

describe('toCsv', () => {
  it('quotes what needs quoting and starts with a BOM for Excel', () => {
    expect(toCsv(['المنتج', 'السعر'], [['Hoodie, black', 1000], ['Say "hi"', null]])).toBe(
      '﻿المنتج,السعر\r\n"Hoodie, black",1000\r\n"Say ""hi""",',
    );
  });
});

describe('toCsvSections', () => {
  it('puts the tables one under the other, each under its title, in one file for Excel', () => {
    const csv = toCsvSections(
      [['تقرير الشهر'], ['من', '2026-10-01', 'إلى', '2026-10-31']],
      [
        { title: 'صافي المبيعات', header: ['البند', 'القيمة'], rows: [['الصافي', 2000]] },
        { title: 'الأصناف', header: ['الصنف', 'القطع'], rows: [['Hoodie, M', 3]] },
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'تقرير الشهر',
      'من,2026-10-01,إلى,2026-10-31',
      '',
      'صافي المبيعات',
      'البند,القيمة',
      'الصافي,2000',
      '',
      'الأصناف',
      'الصنف,القطع',
      '"Hoodie, M",3',
    ]);
  });
});

describe('completed sales', () => {
  const month = { from: '2026-10-01', to: '2026-10-31' };
  const shirt = { product_id: 'shirt', product_title: 'Shirt', variant_id: 'shirt-l', sku: 'S-L', size: 'L', color: null };
  const lines = [
    sale({ order_id: 'a', line_id: 'a1' }), // delivered, paid
    sale({ order_id: 'b', line_id: 'b1', discounts_egp: 100, net_egp: 900 }), // refused at the door
    sale({ order_id: 'c', line_id: 'c1', ...shirt, quantity: 2, gross_egp: 1000, net_egp: 1000 }), // the shop; one sent back after
    sale({ order_id: 'd', line_id: 'd1' }), // delivered, the money still with Accurate
    sale({ order_id: 'e', line_id: 'e1', quantity: 2, gross_egp: 2000, discounts_egp: 200, net_egp: 1800 }), // on the road
    sale({ order_id: 'f', line_id: 'f1' }), // paid before it shipped, still packed
    sale({ order_id: 'g', line_id: 'g1' }), // kept the M ...
    sale({ order_id: 'g', line_id: 'g2', variant_id: 'hoodie-l', sku: 'H-L', size: 'L' }), // ... and refused the L
    sale({ order_id: 'h', line_id: 'h1', ...shirt, gross_egp: 500, net_egp: 500 }), // exchanged ...
    sale({ order_id: 'i', line_id: 'i1', placed_on: '2026-10-25' }), // ... for this hoodie, delivered and paid
    sale({ order_id: 'j', line_id: 'j1', ...shirt, gross_egp: 500, net_egp: 500 }), // exchanged ...
    sale({ order_id: 'k', line_id: 'k1', placed_on: '2026-11-02' }), // ... for a hoodie still on the road
    sale({ order_id: 'z', line_id: 'z1', placed_on: '2026-09-30' }), // placed the month before
  ];
  const returns = [
    back({ order_id: 'b', value_egp: 900 }),
    back({ order_id: 'c', ...shirt, return_type: 'post_delivery', reason: 'wrong_size', value_egp: 500 }),
    back({ order_id: 'g', variant_id: 'hoodie-l', sku: 'H-L', size: 'L' }),
    back({ order_id: 'h', ...shirt, return_type: 'exchange', reason: 'wrong_size', value_egp: 500 }),
    back({ order_id: 'j', ...shirt, return_type: 'exchange', reason: 'wrong_size', returned_on: '2026-11-02', value_egp: 500 }),
  ];
  const orders = [
    order({ order_id: 'a', shipping_egp: 60 }),
    order({ order_id: 'b', net_egp: 900, outcome: 'refused', fulfillment_status: 'returned', payment_status: 'pending', shipping_egp: 60 }),
    order({ order_id: 'c', courier: null, channel: 'store', units: 2 }),
    order({ order_id: 'd', payment_status: 'pending', shipping_egp: 60 }),
    order({ order_id: 'e', units: 2, net_egp: 1800, outcome: 'open', fulfillment_status: 'in_transit', payment_status: 'pending' }),
    order({ order_id: 'f', outcome: 'open', fulfillment_status: 'packed' }),
    order({ order_id: 'g', units: 2, net_egp: 2000, shipping_egp: 60 }),
    order({ order_id: 'h', net_egp: 500, shipping_egp: 60 }),
    order({ order_id: 'i', placed_on: '2026-10-25', is_exchange: true, exchange_for_order_id: 'h', shipping_egp: 60 }),
    order({ order_id: 'j', order_number: '#j', net_egp: 500 }),
    order({
      order_id: 'k',
      order_number: '#k',
      placed_on: '2026-11-02',
      is_exchange: true,
      exchange_for_order_id: 'j',
      outcome: 'open',
      fulfillment_status: 'in_transit',
      payment_status: 'pending',
    }),
    order({ order_id: 'z', placed_on: '2026-09-30' }),
  ];
  const sold = leaveOutRefusals({ lines, returns, orders });
  const done = completedSales(sold.lines, sold.returns, sold.orders, month);

  it('counts what was delivered with its money in, less every piece refused or sent back', () => {
    // a 1,000 + c's shirt kept 500 + g's M 1,000 + h's shirt swapped for i's hoodie 1,000.
    expect(done).toMatchObject({ net: 3500, orders: 4, pieces: 4, averageOrder: 875 });
    // Shipping apart, every time it was paid: a and g, and h and its replacement.
    expect(done.shipping).toBe(240);
  });

  it('keeps an exchange on the order the customer placed, complete once the new piece is', () => {
    // i and k are no more sales than h and j; k, placed in November, is October's.
    expect(done.placed).toBe(9);
    expect(done.byStanding.onTheRoad).toEqual({ orders: 2, pieces: 3, net: 2800 });
    expect(done.waiting.at(-1)).toMatchObject({ order_number: '#k', replaces: '#j', standing: 'onTheRoad', pieces: 1, net: 1000 });
    expect(completedSales(sold.lines, sold.returns, sold.orders, { from: '2026-11-01', to: '2026-11-30' }).placed).toBe(0);
  });

  it('says what of the range is not complete yet, and the rest adds up', () => {
    expect(done.byStanding.awaitingMoney).toEqual({ orders: 1, pieces: 1, net: 1000 });
    // Paid before it shipped is not complete: it has not reached the customer.
    expect(done.byStanding.notShipped).toEqual({ orders: 1, pieces: 1, net: 1000 });
    expect(done.byStanding.cameBack.orders).toBe(1);
    expect(done.waiting.map((row) => row.order_id)).toEqual(['d', 'e', 'f', 'k']);
    expect(done.orders + done.waiting.length + done.byStanding.cameBack.orders).toBe(done.placed);
  });

  it('completes an order once its money comes in', () => {
    const paid = sold.orders.map((row) => (row.order_id === 'd' ? { ...row, payment_status: 'paid' } : row));
    expect(completedSales(sold.lines, sold.returns, paid, month)).toMatchObject({ net: 4500, orders: 5 });
    const refunded = sold.orders.map((row) => (row.order_id === 'a' ? { ...row, payment_status: 'refunded' } : row));
    expect(completedSales(sold.lines, sold.returns, refunded, month)).toMatchObject({ net: 2500, orders: 3 });
  });

  it('ranks the variants and lists every item by the pieces kept', () => {
    expect(done.variants.map((row) => [row.label, row.detail, row.pieces, row.net])).toEqual([
      ['Hoodie', 'M / Black', 3, 3000],
      ['Shirt', 'L', 1, 500],
    ]);
    expect(done.items.map((row) => [row.label, row.detail, row.pieces])).toEqual([
      ['Hoodie', 'Black', 3],
      ['Shirt', null, 1],
    ]);
  });
});
