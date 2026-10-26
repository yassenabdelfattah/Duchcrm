import { describe, expect, it } from 'vitest';
import {
  byDay,
  byGovernorate,
  byProduct,
  bySize,
  change,
  customers,
  previousRange,
  rollUp,
  stockHealth,
  summarize,
  toCsv,
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
  ...fields,
});

const week = { from: '2026-10-20', to: '2026-10-26' };

// Three orders: a hoodie delivered, a hoodie with 100 off refused (back on the
// 22nd), and two shirts in the shop.
const lines = [
  sale({ order_id: 'a' }),
  sale({ order_id: 'b', discounts_egp: 100, net_egp: 900, placed_on: '2026-10-21' }),
  sale({ order_id: 'c', product_id: 'shirt', product_title: 'Shirt', variant_id: 'shirt-l', sku: 'S-L', size: 'l', quantity: 2, gross_egp: 1000, net_egp: 1000, channel: 'store' }),
];
const returns = [back({ order_id: 'b', value_egp: 900 })];
const orders = [
  order({ order_id: 'a', customer_id: 'mona', customer_order_no: 1 }),
  order({ order_id: 'b', placed_on: '2026-10-21', net_egp: 900, outcome: 'refused', governorate: 'Giza', customer_id: 'ali', customer_name: 'Ali' }),
  order({ order_id: 'c', channel: 'store', courier: null, net_egp: 1000, units: 2, customer_id: 'mona', customer_order_no: 2 }),
];

describe('dates', () => {
  it('compares a week with the week before it', () => {
    expect(previousRange(week)).toEqual({ from: '2026-10-13', to: '2026-10-19' });
  });

  it('compares a month with the same number of days before it', () => {
    expect(previousRange({ from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-08-31', to: '2026-09-30' });
  });
});

describe('summarize', () => {
  const summary = summarize(lines, returns, orders, week);

  it('counts sales the Shopify way: gross, less discounts, less what came back', () => {
    expect(summary.gross).toBe(3000);
    expect(summary.discounts).toBe(100);
    expect(summary.returns).toBe(900);
    expect(summary.net).toBe(2000);
  });

  it('averages an order before returns, as Shopify does', () => {
    expect(summary.orders).toBe(3);
    expect(summary.averageOrder).toBe(966.67);
  });

  it('rates delivery only on courier orders that have finished', () => {
    expect(summary.delivered).toBe(1);
    expect(summary.refused).toBe(1);
    expect(summary.deliveryRate).toBe(0.5);
    expect(summary.refusalRate).toBe(0.5);
  });

  it('takes a return off the period it came back in, not the one it was sold in', () => {
    expect(summarize(lines, returns, orders, { from: '2026-10-20', to: '2026-10-21' }).returns).toBe(0);
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
    const days = byDay(lines, returns, orders, week);
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ day: '2026-10-20', net: 2000, orders: 2, units: 3 });
    expect(days[1]).toMatchObject({ day: '2026-10-21', net: 900, orders: 1 });
    expect(days[2]).toMatchObject({ day: '2026-10-22', net: -900, returns: 900 });
  });

  it('rolls days into weeks that add up', () => {
    const [onlyWeek] = rollUp(byDay(lines, returns, orders, week), 'week');
    expect(onlyWeek).toMatchObject({ day: '2026-10-20', net: 2000, orders: 3, units: 4 });
  });
});

describe('what sold', () => {
  it('totals each product, with what came back taken off', () => {
    const rows = byProduct(lines, returns, week);
    expect(rows.find((row) => row.label === 'Shirt')).toMatchObject({ units: 2, net: 1000, returnRate: 0 });
    expect(rows.find((row) => row.label === 'Hoodie')).toMatchObject({
      units: 2,
      unitsReturned: 1,
      net: 1000,
      returnRate: 0.5,
    });
  });

  it('ranks by net sales', () => {
    const rows = byProduct([...lines, sale({ order_id: 'd', placed_on: '2026-10-23' })], returns, week);
    expect(rows.map((row) => row.label)).toEqual(['Hoodie', 'Shirt']);
  });

  it('adds sizes up across products whatever their case', () => {
    const sizes = bySize(lines, returns, week);
    expect(sizes.map((row) => [row.label, row.units])).toEqual([
      ['M', 2],
      ['L', 2],
    ]);
  });
});

describe('where from', () => {
  it('rates refusals by governorate', () => {
    const rows = byGovernorate(orders, week);
    expect(rows.find((row) => row.key === 'Giza')).toMatchObject({ orders: 1, refused: 1, refusalRate: 1 });
    expect(rows.find((row) => row.key === 'Cairo')).toMatchObject({ orders: 2, delivered: 2, refusalRate: 0 });
  });
});

describe('customers', () => {
  it('tells a first order from a returning customer, and ranks who spent most', () => {
    const result = customers(orders, week);
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

describe('toCsv', () => {
  it('quotes what needs quoting and starts with a BOM for Excel', () => {
    expect(toCsv(['المنتج', 'السعر'], [['Hoodie, black', 1000], ['Say "hi"', null]])).toBe(
      '﻿المنتج,السعر\r\n"Hoodie, black",1000\r\n"Say ""hi""",',
    );
  });
});
