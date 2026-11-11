/**
 * Profit, the way the owner counts it (2026-11-11).
 *
 * A piece counts once it is delivered and its money is ours, in the month it
 * was ordered (completedSales). From what it sold for come off, per piece:
 * what it cost to make, the amount set aside against courier losses, the
 * amount set aside for the gift fund, and its share of the ads. That is the
 * product's profit. Then, for the whole period: what is left of the courier
 * reserve after what the courier really cost is added back, the fixed costs
 * come off, and dead stock the gift fund bought counts as sold.
 *
 * Everything here is worked in piastres, as whole numbers, so every line of
 * the statement adds up to the next one exactly.
 */

import { toPiastres } from '@duch/shared';
import { daysBetween, within, type Range, type SaleLine } from './reportMath';

// --- Money as whole piastres -----------------------------------------------------------------

const toP = (egp: number | string | null | undefined) => Math.round(toPiastres(Number(egp ?? 0)) * 100);
const toE = (piastres: number) => toPiastres(piastres / 100);

/**
 * A total shared out by weight, to the piastre: the shares add up to the
 * total exactly, the odd piastres going to the largest remainders.
 */
export function allocate(total: number, weights: number[]): number[] {
  const totalP = toP(total);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalP === 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (totalP * weight) / sum);
  const shares = exact.map((value) => Math.floor(value));
  let left = totalP - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let i = 0; left > 0 && i < order.length; i += 1, left -= 1) shares[order[i]!.index]! += 1;
  return shares.map(toE);
}

// --- What a piece costs ------------------------------------------------------------------------

export type CostKind = 'cost' | 'loss_reserve' | 'gift_reserve';

export interface CostOverride {
  size: string | null;
  color: string | null;
  amount_egp: number;
}

export interface CostLine {
  kind: CostKind;
  label: string;
  amount_egp: number;
  overrides: CostOverride[];
}

export interface CostSheet {
  id: string;
  product_id: string;
  /** Cairo day the cost counts from. */
  effective_from: string;
  note: string | null;
  lines: CostLine[];
}

/** The rows as the tables hold them, put together into sheets by product, oldest first. */
export function buildSheets(
  sheets: Array<{ id: string; product_id: string; effective_from: string; note: string | null }>,
  lines: Array<{ id: string; sheet_id: string; kind: CostKind; label: string; amount_egp: number; position: number }>,
  overrides: Array<{ line_id: string; size: string | null; color: string | null; amount_egp: number }>,
): Map<string, CostSheet[]> {
  const byLine = new Map<string, CostOverride[]>();
  for (const row of overrides) {
    const list = byLine.get(row.line_id) ?? [];
    list.push({ size: row.size, color: row.color, amount_egp: Number(row.amount_egp) });
    byLine.set(row.line_id, list);
  }
  const bySheet = new Map<string, CostLine[]>();
  for (const row of [...lines].sort((a, b) => a.position - b.position)) {
    const list = bySheet.get(row.sheet_id) ?? [];
    list.push({ kind: row.kind, label: row.label, amount_egp: Number(row.amount_egp), overrides: byLine.get(row.id) ?? [] });
    bySheet.set(row.sheet_id, list);
  }
  const byProduct = new Map<string, CostSheet[]>();
  for (const row of [...sheets].sort((a, b) => a.effective_from.localeCompare(b.effective_from))) {
    const list = byProduct.get(row.product_id) ?? [];
    list.push({ ...row, lines: bySheet.get(row.id) ?? [] });
    byProduct.set(row.product_id, list);
  }
  return byProduct;
}

/**
 * The sheet a sale ordered on this day is costed by: the latest one in force
 * that day. A sale from before the first sheet is costed by the first - a
 * cost typed in today covers what was sold before anyone typed one.
 */
export function sheetFor(sheets: CostSheet[] | undefined, day: string): CostSheet | null {
  if (!sheets || sheets.length === 0) return null;
  let found: CostSheet | null = null;
  for (const sheet of sheets) if (sheet.effective_from <= day) found = sheet;
  return found ?? sheets[0]!;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * What a line comes to for one size and colour. The most exact exception
 * wins: this colour in this size, then the size, then the colour.
 */
export function lineAmount(line: CostLine, size: string | null, color: string | null): number {
  const matches = line.overrides.filter(
    (rule) => (rule.size === null || same(rule.size, size)) && (rule.color === null || same(rule.color, color)),
  );
  if (matches.length === 0) return Number(line.amount_egp);
  const rank = (rule: CostOverride) => (rule.size !== null && rule.color !== null ? 3 : rule.size !== null ? 2 : 1);
  return Number(matches.sort((a, b) => rank(b) - rank(a))[0]!.amount_egp);
}

export interface PieceCost {
  /** Each line as it comes to for this size and colour. */
  lines: Array<{ kind: CostKind; label: string; amount: number }>;
  /** Spent making it. */
  cost: number;
  /** Set aside against what the courier costs. */
  lossReserve: number;
  /** Set aside for the gift fund. */
  giftReserve: number;
}

export function pieceCost(sheet: CostSheet, size: string | null, color: string | null): PieceCost {
  const lines = sheet.lines.map((line) => ({ kind: line.kind, label: line.label, amount: lineAmount(line, size, color) }));
  const of = (kind: CostKind) => toE(lines.filter((line) => line.kind === kind).reduce((total, line) => total + toP(line.amount), 0));
  return { lines, cost: of('cost'), lossReserve: of('loss_reserve'), giftReserve: of('gift_reserve') };
}

// --- What was spent ----------------------------------------------------------------------------

export interface AdSpendRow {
  id: string;
  platform: string;
  from_date: string;
  to_date: string;
  amount_egp: number;
  note: string | null;
}

/**
 * The part of an ad payment that falls in the range: the amount spread evenly
 * over its days, for the days of it inside the range.
 */
export function adShare(row: AdSpendRow, range: Range): number {
  const from = row.from_date > range.from ? row.from_date : range.from;
  const to = row.to_date < range.to ? row.to_date : range.to;
  if (from > to) return 0;
  const days = daysBetween(row.from_date, row.to_date);
  return toPiastres((Number(row.amount_egp) * daysBetween(from, to)) / days);
}

export interface ExpenseRow {
  id: string;
  kind: 'expense' | 'gift';
  spent_on: string;
  category: string;
  amount_egp: number;
  note: string | null;
  stock_out_id: string | null;
}

/** A piece the gift fund bought off our own shelf, with what it is. */
export interface GiftPiece {
  expense_id: string;
  spent_on: string;
  product_id: string | null;
  product_title: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unit_price_egp: number;
}

export type CourierKind =
  | 'refused'
  | 'no_response'
  | 'returned_other'
  | 'free_shipping'
  | 'fee_gap'
  | 'collection_gap'
  | 'adjustment';

export const COURIER_KINDS: CourierKind[] = [
  'refused',
  'no_response',
  'returned_other',
  'free_shipping',
  'fee_gap',
  'collection_gap',
  'adjustment',
];

/** What a parcel cost us on a courier statement - v_profit_courier. Negative is a gain. */
export interface CourierCostRow {
  line_id: string;
  settlement_id: string;
  reference: string | null;
  statement_status: string;
  statement_on: string | null;
  order_id: string | null;
  order_number: string | null;
  counted_on: string;
  tracking_number: string | null;
  note: string | null;
  kind: CourierKind;
  cost_egp: number;
}

// --- The statement -------------------------------------------------------------------------------

/** A piece of a completed sale: the line it is on, how many the customer kept, what they came to. */
export interface SoldLine {
  line: SaleLine;
  pieces: number;
  net: number;
}

export interface ProfitRow {
  key: string;
  product_id: string | null;
  title: string;
  /** Size and colour, on a variant's row. */
  detail: string | null;
  sku: string | null;
  pieces: number;
  sales: number;
  cost: number;
  lossReserve: number;
  giftReserve: number;
  ads: number;
  profit: number;
  /** Profit on one piece; null when none sold. */
  perPiece: number | null;
  /** Share of the sales kept as profit; null when nothing sold. */
  margin: number | null;
  /** False when some of its pieces have no cost typed in: its profit is overstated. */
  costed: boolean;
}

export interface ProductProfit extends ProfitRow {
  variants: ProfitRow[];
  /** What one piece is made of today, by line - null when no cost is typed in. */
  breakdown: Array<{ kind: CostKind; label: string; amount: number }> | null;
}

export interface ProfitInput {
  range: Range;
  /** completedSales(...).sold for the range. */
  sold: SoldLine[];
  sheets: Map<string, CostSheet[]>;
  ads: AdSpendRow[];
  expenses: ExpenseRow[];
  giftPieces: GiftPiece[];
  courier: CourierCostRow[];
  /**
   * The day the gift fund starts counting. A sale ordered before it sets
   * nothing aside for the fund - so what comes off profit for the fund is
   * exactly what goes into it.
   */
  giftFrom?: string;
}

export interface ProfitReport {
  range: Range;
  pieces: number;
  sales: number;
  /** Spent making what sold, and the same by line name. */
  manufacturing: number;
  manufacturingLines: Array<{ label: string; amount: number }>;
  lossReserve: number;
  giftReserve: number;
  ads: number;
  adRows: Array<AdSpendRow & { share: number }>;
  /** Sales less making, both reserves and ads: what the products made. */
  productsProfit: number;
  /** What the courier cost on reviewed statements, for orders placed in the range. */
  courier: number;
  courierKinds: Array<{ kind: CourierKind; count: number; amount: number }>;
  courierRows: CourierCostRow[];
  /** On statements still being entered: not counted yet. */
  courierDraft: { count: number; amount: number };
  /** The reserve less what the courier cost: added to profit, or short when negative. */
  lossLeftover: number;
  fixed: number;
  fixedCategories: Array<{ category: string; amount: number; rows: ExpenseRow[] }>;
  /** Dead stock the gift fund bought: counted as sold at the price paid. */
  giftStock: { pieces: number; sales: number; cost: number; profit: number; rows: Array<GiftPiece & { cost: number }> };
  net: number;
  margin: number | null;
  products: ProductProfit[];
  variants: ProfitRow[];
  /** Sold in the range with no cost typed in. */
  uncosted: Array<{ product_id: string | null; title: string; pieces: number }>;
}

interface Acc {
  key: string;
  product_id: string | null;
  title: string;
  detail: string | null;
  sku: string | null;
  size: string | null;
  color: string | null;
  pieces: number;
  sales: number;
  cost: number;
  loss: number;
  gift: number;
  uncosted: number;
}

export function profitReport(input: ProfitInput): ProfitReport {
  const { range, sheets } = input;

  // Each variant sold, in piastres.
  const variants = new Map<string, Acc>();
  const labels = new Map<string, number>();
  for (const { line, pieces, net } of input.sold) {
    if (pieces <= 0) continue;
    const key = line.variant_id ?? line.sku;
    let acc = variants.get(key);
    if (!acc) {
      acc = {
        key,
        product_id: line.product_id,
        title: line.product_title,
        detail: [line.size, line.color].filter(Boolean).join(' / ') || null,
        sku: line.sku,
        size: line.size,
        color: line.color,
        pieces: 0,
        sales: 0,
        cost: 0,
        loss: 0,
        gift: 0,
        uncosted: 0,
      };
      variants.set(key, acc);
    }
    acc.pieces += pieces;
    acc.sales += toP(net);
    // Costed by the sheet in force the day this order was placed.
    const sheet = line.product_id ? sheetFor(sheets.get(line.product_id), line.placed_on) : null;
    if (!sheet) {
      acc.uncosted += pieces;
      continue;
    }
    for (const part of pieceCost(sheet, line.size, line.color).lines) {
      const amount = toP(part.amount) * pieces;
      if (part.kind === 'cost') {
        acc.cost += amount;
        labels.set(part.label, (labels.get(part.label) ?? 0) + amount);
      } else if (part.kind === 'loss_reserve') acc.loss += amount;
      else if (!input.giftFrom || line.placed_on >= input.giftFrom) acc.gift += amount;
    }
  }

  const list = [...variants.values()];
  const pieces = list.reduce((total, row) => total + row.pieces, 0);

  // Ads: what falls in the range, shared out by pieces sold.
  const adRows = input.ads
    .map((row) => ({ ...row, share: adShare(row, range) }))
    .filter((row) => row.share > 0)
    .sort((a, b) => a.from_date.localeCompare(b.from_date));
  const adsP = adRows.reduce((total, row) => total + toP(row.share), 0);
  const adShares = allocate(
    toE(adsP),
    list.map((row) => row.pieces),
  );

  const finish = (acc: Acc, ads: number): ProfitRow => {
    const profit = acc.sales - acc.cost - acc.loss - acc.gift - toP(ads);
    return {
      key: acc.key,
      product_id: acc.product_id,
      title: acc.title,
      detail: acc.detail,
      sku: acc.sku,
      pieces: acc.pieces,
      sales: toE(acc.sales),
      cost: toE(acc.cost),
      lossReserve: toE(acc.loss),
      giftReserve: toE(acc.gift),
      ads,
      profit: toE(profit),
      perPiece: acc.pieces > 0 ? toE(Math.round(profit / acc.pieces)) : null,
      margin: acc.sales > 0 ? profit / acc.sales : null,
      costed: acc.uncosted === 0,
    };
  };

  const variantRows = list.map((acc, index) => finish(acc, adShares[index] ?? 0));

  // Products: the sum of their variants, so the two tables agree to the piastre.
  const products = new Map<string, { acc: Acc; ads: number; rows: ProfitRow[] }>();
  list.forEach((acc, index) => {
    const key = acc.product_id ?? acc.title;
    const group = products.get(key) ?? {
      acc: { ...acc, key, detail: null, sku: null, pieces: 0, sales: 0, cost: 0, loss: 0, gift: 0, uncosted: 0 },
      ads: 0,
      rows: [],
    };
    group.acc.pieces += acc.pieces;
    group.acc.sales += acc.sales;
    group.acc.cost += acc.cost;
    group.acc.loss += acc.loss;
    group.acc.gift += acc.gift;
    group.acc.uncosted += acc.uncosted;
    group.ads += toP(adShares[index] ?? 0);
    group.rows.push(variantRows[index]!);
    products.set(key, group);
  });
  const byProfit = (a: ProfitRow, b: ProfitRow) => b.profit - a.profit || b.pieces - a.pieces || a.title.localeCompare(b.title);
  const productRows: ProductProfit[] = [...products.values()]
    .map(({ acc, ads, rows }) => {
      const sheet = acc.product_id ? sheetFor(sheets.get(acc.product_id), range.to) : null;
      return {
        ...finish(acc, toE(ads)),
        variants: rows.sort(byProfit),
        breakdown: sheet ? sheet.lines.map((line) => ({ kind: line.kind, label: line.label, amount: Number(line.amount_egp) })) : null,
      };
    })
    .sort(byProfit);

  const salesP = list.reduce((total, row) => total + row.sales, 0);
  const costP = list.reduce((total, row) => total + row.cost, 0);
  const lossP = list.reduce((total, row) => total + row.loss, 0);
  const giftP = list.reduce((total, row) => total + row.gift, 0);
  const productsP = salesP - costP - lossP - giftP - adsP;

  // The courier: reviewed statements only, for orders placed in the range.
  const inRange = input.courier.filter((row) => within(row.counted_on, range));
  const courierRows = inRange.filter((row) => row.statement_status !== 'draft');
  const drafts = inRange.filter((row) => row.statement_status === 'draft');
  const courierP = courierRows.reduce((total, row) => total + toP(row.cost_egp), 0);
  const courierKinds = COURIER_KINDS.map((kind) => {
    const of = courierRows.filter((row) => row.kind === kind);
    return { kind, count: of.length, amount: toE(of.reduce((total, row) => total + toP(row.cost_egp), 0)) };
  }).filter((row) => row.count > 0);

  // Fixed costs paid in the range, by what they were for.
  const fixedRows = input.expenses.filter((row) => row.kind === 'expense' && within(row.spent_on, range));
  const categories = new Map<string, ExpenseRow[]>();
  for (const row of fixedRows) {
    const key = row.category.trim();
    categories.set(key, [...(categories.get(key) ?? []), row]);
  }
  const fixedCategories = [...categories.entries()]
    .map(([category, rows]) => ({ category, rows, amount: toE(rows.reduce((total, row) => total + toP(row.amount_egp), 0)) }))
    .sort((a, b) => b.amount - a.amount);
  const fixedP = fixedRows.reduce((total, row) => total + toP(row.amount_egp), 0);

  // Dead stock the gift fund bought in the range: sold at the price typed in.
  const giftRows = input.giftPieces
    .filter((row) => within(row.spent_on, range))
    .map((row) => {
      const sheet = row.product_id ? sheetFor(sheets.get(row.product_id), row.spent_on) : null;
      const each = sheet ? pieceCost(sheet, row.size, row.color).cost : 0;
      return { ...row, cost: toE(toP(each) * row.quantity) };
    });
  const giftSalesP = giftRows.reduce((total, row) => total + toP(row.unit_price_egp) * row.quantity, 0);
  const giftCostP = giftRows.reduce((total, row) => total + toP(row.cost), 0);

  const netP = productsP + (lossP - courierP) - fixedP + (giftSalesP - giftCostP);

  return {
    range,
    pieces,
    sales: toE(salesP),
    manufacturing: toE(costP),
    manufacturingLines: [...labels.entries()].map(([label, amount]) => ({ label, amount: toE(amount) })).sort((a, b) => b.amount - a.amount),
    lossReserve: toE(lossP),
    giftReserve: toE(giftP),
    ads: toE(adsP),
    adRows,
    productsProfit: toE(productsP),
    courier: toE(courierP),
    courierKinds,
    courierRows: courierRows.sort((a, b) => Number(b.cost_egp) - Number(a.cost_egp)),
    courierDraft: { count: drafts.length, amount: toE(drafts.reduce((total, row) => total + toP(row.cost_egp), 0)) },
    lossLeftover: toE(lossP - courierP),
    fixed: toE(fixedP),
    fixedCategories,
    giftStock: {
      pieces: giftRows.reduce((total, row) => total + row.quantity, 0),
      sales: toE(giftSalesP),
      cost: toE(giftCostP),
      profit: toE(giftSalesP - giftCostP),
      rows: giftRows,
    },
    net: toE(netP),
    margin: salesP > 0 ? netP / salesP : null,
    products: productRows,
    variants: variantRows.sort(byProfit),
    uncosted: productRows
      .filter((row) => !row.costed)
      .map((row) => ({ product_id: row.product_id, title: row.title, pieces: row.pieces })),
  };
}

// --- The gift fund ---------------------------------------------------------------------------------

export interface GiftFund {
  /** In the fund when the range starts. */
  opening: number;
  /** Set aside from the pieces sold in the range. */
  collected: number;
  spent: number;
  closing: number;
  rows: ExpenseRow[];
}

/**
 * The gift fund over a range. It rolls over: what it holds when the range
 * starts is what it was opened with, plus everything set aside since it
 * started counting, less everything spent from it - both up to the day before.
 */
export function giftFund(input: {
  range: Range;
  /** The day the fund starts counting, and what it held then. */
  from: string;
  openingEgp: number;
  /** Set aside in the range, and from the fund's start up to the day before the range. */
  collected: number;
  collectedBefore: number;
  expenses: ExpenseRow[];
}): GiftFund {
  const gifts = input.expenses.filter((row) => row.kind === 'gift' && row.spent_on >= input.from);
  const before = gifts.filter((row) => row.spent_on < input.range.from);
  const rows = gifts.filter((row) => within(row.spent_on, input.range)).sort((a, b) => a.spent_on.localeCompare(b.spent_on));
  const spentBefore = before.reduce((total, row) => total + toP(row.amount_egp), 0);
  const spent = rows.reduce((total, row) => total + toP(row.amount_egp), 0);
  const opening = toP(input.openingEgp) + toP(input.collectedBefore) - spentBefore;
  return {
    opening: toE(opening),
    collected: toPiastres(input.collected),
    spent: toE(spent),
    closing: toE(opening + toP(input.collected) - spent),
    rows,
  };
}

// --- Months ------------------------------------------------------------------------------------------

/** The calendar month a Cairo day is in, to today at the latest. */
export function monthRange(month: string, today: string): Range {
  const from = `${month}-01`;
  const [year, number] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
  return { from, to: last > today && from <= today ? today : last };
}

export function addMonths(month: string, count: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + count, 1)).toISOString().slice(0, 7);
}
