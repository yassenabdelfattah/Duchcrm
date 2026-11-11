import { describe, expect, it } from 'vitest';
import {
  adShare,
  addMonths,
  allocate,
  buildSheets,
  giftFund,
  lineAmount,
  monthRange,
  pieceCost,
  profitReport,
  sheetFor,
  type AdSpendRow,
  type CostSheet,
  type CourierCostRow,
  type ExpenseRow,
  type SoldLine,
} from '../apps/dashboard/src/lib/profitMath';
import { completedSales, leaveOutRefusals, type ReportOrder, type ReturnLine, type SaleLine } from '../apps/dashboard/src/lib/reportMath';

const october = { from: '2026-10-01', to: '2026-10-31' };

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

const sold = (fields: Partial<SaleLine>, pieces = 1, net?: number): SoldLine => {
  const line = sale(fields);
  return { line, pieces, net: net ?? Number(line.net_egp) };
};

const order = (fields: Partial<ReportOrder>): ReportOrder => ({
  order_id: 'o',
  order_number: '#1',
  placed_on: '2026-10-20',
  channel: 'online',
  payment_method: 'cod',
  governorate: 'Cairo',
  customer_id: 'c',
  customer_name: 'Customer',
  customer_phone: '0100',
  is_exchange: false,
  net_egp: 1000,
  units: 1,
  courier: 'accurate',
  outcome: 'delivered',
  customer_order_no: 1,
  fulfillment_status: 'delivered',
  shipping_egp: 80,
  payment_status: 'paid',
  exchange_for_order_id: null,
  ...fields,
});

/** Fabric 120 (140 in XL), tailoring 60, packaging 20; 10 against courier losses, 5 for gifts. */
const hoodieSheet = (fields: Partial<CostSheet> = {}): CostSheet => ({
  id: 's1',
  product_id: 'hoodie',
  effective_from: '2026-10-01',
  note: null,
  lines: [
    { kind: 'cost', label: 'قماش', amount_egp: 120, overrides: [{ size: 'XL', color: null, amount_egp: 140 }] },
    { kind: 'cost', label: 'تفصيل', amount_egp: 60, overrides: [] },
    { kind: 'cost', label: 'تغليف', amount_egp: 20, overrides: [] },
    { kind: 'loss_reserve', label: 'مخصص الشحن', amount_egp: 10, overrides: [] },
    { kind: 'gift_reserve', label: 'مخصص الهدايا', amount_egp: 5, overrides: [] },
  ],
  ...fields,
});

const sheets = (...list: CostSheet[]) => {
  const map = new Map<string, CostSheet[]>();
  for (const sheet of [...list].sort((a, b) => a.effective_from.localeCompare(b.effective_from))) {
    map.set(sheet.product_id, [...(map.get(sheet.product_id) ?? []), sheet]);
  }
  return map;
};

const ad = (fields: Partial<AdSpendRow>): AdSpendRow => ({
  id: 'a',
  platform: 'meta',
  from_date: '2026-10-01',
  to_date: '2026-10-31',
  amount_egp: 3100,
  note: null,
  ...fields,
});

const expense = (fields: Partial<ExpenseRow>): ExpenseRow => ({
  id: 'e',
  kind: 'expense',
  spent_on: '2026-10-05',
  category: 'إيجار',
  amount_egp: 100,
  note: null,
  stock_out_id: null,
  ...fields,
});

const courier = (fields: Partial<CourierCostRow>): CourierCostRow => ({
  line_id: 'c',
  settlement_id: 's',
  reference: 'CSHP-1',
  statement_status: 'reviewed',
  statement_on: '2026-10-25',
  order_id: 'o9',
  order_number: '#9',
  counted_on: '2026-10-12',
  tracking_number: 'T',
  note: null,
  kind: 'refused',
  cost_egp: 85,
  ...fields,
});

const empty = { ads: [], expenses: [], giftPieces: [], courier: [] };

describe('allocate', () => {
  it('shares a total out by weight and adds up exactly', () => {
    const shares = allocate(100, [1, 1, 1]);
    expect(shares).toEqual([33.34, 33.33, 33.33]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
  });

  it('gives nothing when there is nothing to share between', () => {
    expect(allocate(100, [0, 0])).toEqual([0, 0]);
    expect(allocate(0, [3, 1])).toEqual([0, 0]);
  });
});

describe('what a piece costs', () => {
  it('puts the rows together by product, oldest sheet first, lines in order', () => {
    const built = buildSheets(
      [
        { id: 'new', product_id: 'p', effective_from: '2026-11-01', note: null },
        { id: 'old', product_id: 'p', effective_from: '2026-10-01', note: null },
      ],
      [
        { id: 'l2', sheet_id: 'old', kind: 'cost', label: 'تفصيل', amount_egp: 60, position: 1 },
        { id: 'l1', sheet_id: 'old', kind: 'cost', label: 'قماش', amount_egp: 120, position: 0 },
      ],
      [{ line_id: 'l1', size: 'XL', color: null, amount_egp: 140 }],
    );
    const list = built.get('p')!;
    expect(list.map((sheet) => sheet.id)).toEqual(['old', 'new']);
    expect(list[0]!.lines.map((line) => line.label)).toEqual(['قماش', 'تفصيل']);
    expect(list[0]!.lines[0]!.overrides).toEqual([{ size: 'XL', color: null, amount_egp: 140 }]);
  });

  it('costs a sale by the sheet in force the day it was ordered', () => {
    const list = [hoodieSheet({ id: 'oct', effective_from: '2026-10-01' }), hoodieSheet({ id: 'nov', effective_from: '2026-11-10' })];
    expect(sheetFor(list, '2026-10-20')!.id).toBe('oct');
    expect(sheetFor(list, '2026-11-09')!.id).toBe('oct');
    expect(sheetFor(list, '2026-11-10')!.id).toBe('nov');
    expect(sheetFor(list, '2026-12-01')!.id).toBe('nov');
  });

  it('costs a sale from before the first sheet by the first', () => {
    expect(sheetFor([hoodieSheet({ id: 'oct' })], '2026-09-28')!.id).toBe('oct');
    expect(sheetFor([], '2026-09-28')).toBeNull();
    expect(sheetFor(undefined, '2026-09-28')).toBeNull();
  });

  it('lets a line differ by size or colour, the most exact rule winning', () => {
    const line = {
      kind: 'cost' as const,
      label: 'قماش',
      amount_egp: 120,
      overrides: [
        { size: null, color: 'Red', amount_egp: 130 },
        { size: 'XL', color: null, amount_egp: 140 },
        { size: 'XL', color: 'Red', amount_egp: 155 },
      ],
    };
    expect(lineAmount(line, 'M', 'Black')).toBe(120);
    expect(lineAmount(line, 'M', 'red')).toBe(130);
    expect(lineAmount(line, 'xl', 'Black')).toBe(140);
    expect(lineAmount(line, 'XL', 'Red')).toBe(155);
    expect(lineAmount(line, null, null)).toBe(120);
  });

  it('adds a piece up by kind', () => {
    expect(pieceCost(hoodieSheet(), 'M', 'Black')).toMatchObject({ cost: 200, lossReserve: 10, giftReserve: 5 });
    expect(pieceCost(hoodieSheet(), 'XL', 'Black')).toMatchObject({ cost: 220, lossReserve: 10, giftReserve: 5 });
  });
});

describe('ad spend', () => {
  it('counts the days of a payment that fall in the range', () => {
    expect(adShare(ad({}), october)).toBe(3100);
    // 3,100 over 31 days is 100 a day; ten of them are in the range.
    expect(adShare(ad({}), { from: '2026-10-22', to: '2026-11-30' })).toBe(1000);
    expect(adShare(ad({ from_date: '2026-09-21', to_date: '2026-10-10', amount_egp: 2000 }), october)).toBe(1000);
    expect(adShare(ad({}), { from: '2026-11-01', to: '2026-11-30' })).toBe(0);
  });
});

describe('profitReport', () => {
  it('takes making, both reserves and ads off each product, then settles the period', () => {
    const report = profitReport({
      range: october,
      sold: [
        sold({ line_id: 'a', variant_id: 'hoodie-m', size: 'M' }, 3, 3000),
        sold({ line_id: 'b', variant_id: 'hoodie-xl', sku: 'H-XL', size: 'XL' }, 1, 1000),
      ],
      sheets: sheets(hoodieSheet()),
      ads: [ad({ amount_egp: 400 })],
      expenses: [
        expense({ id: 'rent', category: 'إيجار', amount_egp: 500 }),
        expense({ id: 'pay', category: 'مرتبات', amount_egp: 300 }),
        expense({ id: 'later', spent_on: '2026-11-02', amount_egp: 999 }),
        expense({ id: 'gift', kind: 'gift', category: 'هدية', amount_egp: 50 }),
      ],
      giftPieces: [],
      courier: [
        courier({ line_id: 'r1', kind: 'refused', cost_egp: 85 }),
        courier({ line_id: 'r2', kind: 'no_response', cost_egp: 15 }),
        courier({ line_id: 'g1', kind: 'fee_gap', cost_egp: -5 }),
        courier({ line_id: 'draft', statement_status: 'draft', cost_egp: 70 }),
        courier({ line_id: 'nov', counted_on: '2026-11-03', cost_egp: 60 }),
      ],
    });

    expect(report.pieces).toBe(4);
    expect(report.sales).toBe(4000);
    // Three M at 200 and one XL at 220.
    expect(report.manufacturing).toBe(820);
    expect(report.manufacturingLines).toEqual([
      { label: 'قماش', amount: 500 },
      { label: 'تفصيل', amount: 240 },
      { label: 'تغليف', amount: 80 },
    ]);
    expect(report.lossReserve).toBe(40);
    expect(report.giftReserve).toBe(20);
    expect(report.ads).toBe(400);
    expect(report.productsProfit).toBe(2720);

    // Reviewed statements for orders placed in the range only; a gain comes off.
    expect(report.courier).toBe(95);
    expect(report.courierKinds).toEqual([
      { kind: 'refused', count: 1, amount: 85 },
      { kind: 'no_response', count: 1, amount: 15 },
      { kind: 'fee_gap', count: 1, amount: -5 },
    ]);
    expect(report.courierDraft).toEqual({ count: 1, amount: 70 });
    // 40 set aside, 95 spent: 55 short, and it comes off profit.
    expect(report.lossLeftover).toBe(-55);

    expect(report.fixed).toBe(800);
    expect(report.fixedCategories.map((row) => [row.category, row.amount])).toEqual([
      ['إيجار', 500],
      ['مرتبات', 300],
    ]);

    // 2,720 - 55 - 800. The gift reserve stays out: it is the fund's.
    expect(report.net).toBe(1865);
    expect(report.margin).toBeCloseTo(1865 / 4000, 10);
    // The same thing the long way: sales less every real cost and the gift reserve.
    expect(report.net).toBe(report.sales - report.manufacturing - report.ads - report.courier - report.fixed - report.giftReserve);
  });

  it('shares ads by pieces, and products add up to their variants', () => {
    const report = profitReport({
      ...empty,
      range: october,
      sold: [
        sold({ line_id: 'a', variant_id: 'hoodie-m', size: 'M' }, 3, 3000),
        sold({ line_id: 'b', variant_id: 'hoodie-xl', sku: 'H-XL', size: 'XL' }, 1, 1000),
        sold({ line_id: 'c', product_id: 'cap', product_title: 'Cap', variant_id: 'cap', sku: 'CAP', size: null, color: null }, 2, 600),
      ],
      sheets: sheets(hoodieSheet()),
      ads: [ad({ amount_egp: 100 })],
    });

    const byKey = new Map(report.variants.map((row) => [row.key, row]));
    // 100 over six pieces: 50, 16.67, 33.33.
    expect(byKey.get('hoodie-m')!.ads).toBe(50);
    expect(byKey.get('hoodie-xl')!.ads).toBe(16.67);
    expect(byKey.get('cap')!.ads).toBe(33.33);
    expect(report.variants.reduce((total, row) => total + row.ads * 100, 0)).toBeCloseTo(10000, 6);

    const hoodie = report.products.find((row) => row.key === 'hoodie')!;
    expect(hoodie.pieces).toBe(4);
    expect(hoodie.sales).toBe(4000);
    expect(hoodie.cost).toBe(820);
    expect(hoodie.ads).toBe(66.67);
    // 4,000 - 820 - 40 - 20 - 66.67
    expect(hoodie.profit).toBe(3053.33);
    expect(hoodie.variants.map((row) => row.key)).toEqual(['hoodie-m', 'hoodie-xl']);
    expect(hoodie.profit).toBeCloseTo(hoodie.variants.reduce((total, row) => total + row.profit, 0), 6);
    expect(hoodie.breakdown!.map((line) => line.label)).toEqual(['قماش', 'تفصيل', 'تغليف', 'مخصص الشحن', 'مخصص الهدايا']);

    // The products add up to the statement's line.
    expect(report.products.reduce((total, row) => total + row.profit * 100, 0)).toBeCloseTo(report.productsProfit * 100, 6);
  });

  it('names what sold with no cost typed in', () => {
    const report = profitReport({
      ...empty,
      range: october,
      sold: [sold({ line_id: 'c', product_id: 'cap', product_title: 'Cap', variant_id: 'cap', sku: 'CAP' }, 2, 600)],
      sheets: sheets(hoodieSheet()),
    });
    expect(report.uncosted).toEqual([{ product_id: 'cap', title: 'Cap', pieces: 2 }]);
    expect(report.products[0]!.costed).toBe(false);
    expect(report.products[0]!.breakdown).toBeNull();
    expect(report.manufacturing).toBe(0);
  });

  it('keeps the old cost on sales ordered before a new one', () => {
    const report = profitReport({
      ...empty,
      range: { from: '2026-10-01', to: '2026-11-30' },
      sold: [sold({ line_id: 'a', placed_on: '2026-10-20' }), sold({ line_id: 'b', placed_on: '2026-11-12' })],
      sheets: sheets(
        hoodieSheet(),
        hoodieSheet({ id: 's2', effective_from: '2026-11-10', lines: [{ kind: 'cost', label: 'قماش', amount_egp: 300, overrides: [] }] }),
      ),
    });
    // 200 for October's, 300 for the one ordered after the new cost.
    expect(report.manufacturing).toBe(500);
    expect(report.lossReserve).toBe(10);
  });

  it('sets nothing aside for the gift fund from sales ordered before it started', () => {
    const report = profitReport({
      ...empty,
      range: october,
      sold: [sold({ line_id: 'a', placed_on: '2026-10-05' }), sold({ line_id: 'b', placed_on: '2026-10-20' })],
      sheets: sheets(hoodieSheet()),
      giftFrom: '2026-10-15',
    });
    expect(report.giftReserve).toBe(5);
    expect(report.lossReserve).toBe(20);
    // 2,000 - 400 to make - 5 for the fund.
    expect(report.net).toBe(1595);
  });

  it('counts ads even when nothing sold, and no ad share to hand out', () => {
    const report = profitReport({ ...empty, range: october, sold: [], sheets: new Map(), ads: [ad({ amount_egp: 400 })] });
    expect(report.ads).toBe(400);
    expect(report.net).toBe(-400);
    expect(report.margin).toBeNull();
    expect(report.products).toEqual([]);
  });

  it('counts dead stock the gift fund bought as sold at the price paid', () => {
    const report = profitReport({
      ...empty,
      range: october,
      sold: [],
      sheets: sheets(hoodieSheet()),
      giftPieces: [
        { expense_id: 'g', spent_on: '2026-10-15', product_id: 'hoodie', product_title: 'Hoodie', size: 'M', color: 'Black', quantity: 2, unit_price_egp: 300 },
        { expense_id: 'h', spent_on: '2026-11-15', product_id: 'hoodie', product_title: 'Hoodie', size: 'M', color: 'Black', quantity: 5, unit_price_egp: 300 },
      ],
    });
    // Two pieces at 300, each 200 to make.
    expect(report.giftStock).toMatchObject({ pieces: 2, sales: 600, cost: 400, profit: 200 });
    expect(report.net).toBe(200);
  });

  it('counts a parcel kept in part by what was kept', () => {
    // Two pieces ordered; the customer kept one and refused the other at the door.
    const lines = [sale({ quantity: 2, gross_egp: 2000, net_egp: 2000 })];
    const refusal: ReturnLine = {
      return_line_id: 'r',
      order_id: 'o',
      order_number: '#1',
      returned_on: '2026-10-24',
      return_type: 'failed_delivery',
      reason: 'refused_opened',
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
    };
    const rows = leaveOutRefusals({ lines, returns: [refusal], orders: [order({ net_egp: 2000, units: 2 })] });
    const done = completedSales(rows.lines, rows.returns, rows.orders, october);
    const report = profitReport({ ...empty, range: october, sold: done.sold, sheets: sheets(hoodieSheet()) });
    expect(report.pieces).toBe(1);
    expect(report.sales).toBe(1000);
    expect(report.manufacturing).toBe(200);
    // 1,000 - 200 to make - 5 for the gift fund; the 10 set aside against the
    // courier was not needed, so it stays in profit.
    expect(report.net).toBe(795);
  });

  it('counts nothing that is not delivered and paid', () => {
    const orders = [
      order({ order_id: 'paid' }),
      order({ order_id: 'unpaid', payment_status: 'pending' }),
      order({ order_id: 'road', fulfillment_status: 'in_transit', outcome: 'open', payment_status: 'pending' }),
    ];
    const lines = orders.map((row) => sale({ line_id: row.order_id, order_id: row.order_id }));
    const done = completedSales(lines, [], orders, october);
    const report = profitReport({ ...empty, range: october, sold: done.sold, sheets: sheets(hoodieSheet()) });
    expect(report.pieces).toBe(1);
    expect(report.sales).toBe(1000);
    expect(done.byStanding.awaitingMoney.orders).toBe(1);
    expect(done.byStanding.onTheRoad.orders).toBe(1);
  });

  it('takes a piece sent back after it was paid off its own month', () => {
    const lines = [sale({ quantity: 2, gross_egp: 2000, net_egp: 2000 })];
    const returned: ReturnLine = {
      return_line_id: 'r',
      order_id: 'o',
      order_number: '#1',
      returned_on: '2026-11-08',
      return_type: 'post_delivery',
      reason: 'wrong_size',
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
    };
    const done = completedSales(lines, [returned], [order({ net_egp: 2000, units: 2 })], october);
    const report = profitReport({ ...empty, range: october, sold: done.sold, sheets: sheets(hoodieSheet()) });
    expect(report.pieces).toBe(1);
    expect(report.sales).toBe(1000);
  });
});

describe('the gift fund', () => {
  const expenses = [
    expense({ id: 'old', kind: 'gift', spent_on: '2026-09-20', amount_egp: 999 }),
    expense({ id: 'sep', kind: 'gift', spent_on: '2026-10-28', amount_egp: 300 }),
    expense({ id: 'a', kind: 'gift', spent_on: '2026-11-05', amount_egp: 700 }),
    expense({ id: 'b', kind: 'gift', spent_on: '2026-11-20', amount_egp: 500 }),
    expense({ id: 'rent', kind: 'expense', spent_on: '2026-11-01', amount_egp: 5000 }),
    expense({ id: 'next', kind: 'gift', spent_on: '2026-12-02', amount_egp: 100 }),
  ];

  it('rolls over what was not spent', () => {
    const fund = giftFund({
      range: { from: '2026-11-01', to: '2026-11-30' },
      from: '2026-10-01',
      openingEgp: 200,
      collected: 2000,
      collectedBefore: 900,
      expenses,
    });
    // 200 to start + 900 set aside in October - 300 spent in October.
    expect(fund.opening).toBe(800);
    expect(fund.collected).toBe(2000);
    expect(fund.spent).toBe(1200);
    expect(fund.closing).toBe(1600);
    expect(fund.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('can go short', () => {
    const fund = giftFund({ range: { from: '2026-11-01', to: '2026-11-30' }, from: '2026-11-01', openingEgp: 0, collected: 100, collectedBefore: 0, expenses });
    expect(fund.opening).toBe(0);
    expect(fund.closing).toBe(-1100);
  });
});

describe('months', () => {
  it('runs a past month to its last day and this month to today', () => {
    expect(monthRange('2026-10', '2026-11-11')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2026-11', '2026-11-11')).toEqual({ from: '2026-11-01', to: '2026-11-11' });
    expect(monthRange('2026-02', '2026-11-11')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('steps across a year', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});
