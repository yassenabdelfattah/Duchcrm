import { useCallback, useEffect, useState } from 'react';
import { cairoDate } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import {
  addDays,
  leaveOutRefusals,
  type CourierMoneyRow,
  type MoneyInRow,
  type Range,
  type ReportOrder,
  type ReturnLine,
  type SaleLine,
} from '../../lib/reportMath';
import {
  buildSheets,
  type AdSpendRow,
  type CostKind,
  type CostSheet,
  type CourierCostRow,
  type ExpenseRow,
  type GiftPiece,
} from '../../lib/profitMath';

/** The API returns at most 1,000 rows a request; a month of order lines can be more. */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const page = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < page) return rows;
  }
}

/** Runs a load, keeping what was shown while a new one is on its way. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(arabicError(caught as { message?: string; code?: string }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, loading, error, reload };
}

// --- What was sold, and what came back -----------------------------------------------------------

export interface SalesRows {
  /** The day the rows start from. */
  since: string;
  /** Sales, returns and orders without what was refused at the door: it was never a sale. */
  lines: SaleLine[];
  returns: ReturnLine[];
  orders: ReportOrder[];
  /** The refusals at the door themselves. */
  refusals: ReturnLine[];
  /** Every line as ordered, refused pieces included - for "one of two came back". */
  ordered: SaleLine[];
}

/**
 * Every order placed from a day up to today, with what came back of them.
 * Up to today, whatever the range: a sale ordered in October is complete or
 * not by what happened to it since.
 */
async function loadSalesRows(since: string): Promise<SalesRows> {
  const to = cairoDate();
  const [lines, returns, placed, payments] = await Promise.all([
    fetchAll<SaleLine>((a, b) =>
      supabase.from('v_report_lines').select('*').gte('placed_on', since).lte('placed_on', to).order('line_id').range(a, b),
    ),
    fetchAll<ReturnLine>((a, b) =>
      supabase.from('v_report_returns').select('*').gte('returned_on', since).order('return_line_id').range(a, b),
    ),
    fetchAll<Omit<ReportOrder, 'payment_status' | 'exchange_for_order_id'>>((a, b) =>
      supabase.from('v_report_orders').select('*').gte('placed_on', since).lte('placed_on', to).order('order_id').range(a, b),
    ),
    // Whether each order's money is ours, and which order a replacement
    // replaces. From Cairo's midnight in summer time: every order of those
    // days, and a few before.
    fetchAll<{ id: string; payment_status: string; exchange_for_order_id: string | null }>((a, b) =>
      supabase
        .from('orders')
        .select('id, payment_status, exchange_for_order_id')
        .gte('created_at', `${since}T00:00:00+03:00`)
        .order('id')
        .range(a, b),
    ),
  ]);

  const beside = new Map(payments.map((row) => [row.id, row]));
  const orders: ReportOrder[] = placed.map((order) => ({
    ...order,
    payment_status: beside.get(order.order_id)?.payment_status ?? null,
    exchange_for_order_id: beside.get(order.order_id)?.exchange_for_order_id ?? null,
  }));
  // A refusal at the door is neither a sale nor a return (the owner, 2026-11-04).
  const sales = leaveOutRefusals({ lines, returns, orders });
  return { since, lines: sales.lines, returns: sales.returns, orders: sales.orders, refusals: sales.refusals, ordered: lines };
}

/** Null waits: the day to read from is not known yet. */
export function useSalesRows(since: string | null) {
  return useLoad(() => (since ? loadSalesRows(since) : Promise.resolve(null)), [since]);
}

// --- Costs and spending ------------------------------------------------------------------------------

export interface CostVariant {
  id: string;
  product_id: string;
  sku: string;
  size: string | null;
  color: string | null;
  price_egp: number;
  is_active: boolean;
}

export interface CostProduct {
  id: string;
  title: string;
  image_url: string | null;
  status: string;
  variants: CostVariant[];
}

export interface ProfitSettings {
  gift_fund_from: string;
  gift_fund_opening_egp: number;
  report_hidden: string[];
}

export interface ProfitBooks {
  sheets: Map<string, CostSheet[]>;
  products: CostProduct[];
  ads: AdSpendRow[];
  expenses: ExpenseRow[];
  giftPieces: GiftPiece[];
  settings: ProfitSettings;
}

/** Everything typed in about money: costs, ads, expenses, the gift fund. Small tables, read whole. */
async function loadBooks(): Promise<ProfitBooks> {
  const [sheets, lines, overrides, products, variants, ads, expenses, items, settings] = await Promise.all([
    fetchAll<{ id: string; product_id: string; effective_from: string; note: string | null }>((a, b) =>
      supabase.from('cost_sheets').select('id, product_id, effective_from, note').order('id').range(a, b),
    ),
    fetchAll<{ id: string; sheet_id: string; kind: CostKind; label: string; amount_egp: number; position: number }>((a, b) =>
      supabase.from('cost_lines').select('id, sheet_id, kind, label, amount_egp, position').order('id').range(a, b),
    ),
    fetchAll<{ id: string; line_id: string; size: string | null; color: string | null; amount_egp: number }>((a, b) =>
      supabase.from('cost_line_overrides').select('id, line_id, size, color, amount_egp').order('id').range(a, b),
    ),
    fetchAll<Omit<CostProduct, 'variants'>>((a, b) =>
      supabase.from('products').select('id, title, image_url, status').order('title').order('id').range(a, b),
    ),
    fetchAll<CostVariant>((a, b) =>
      supabase.from('variants').select('id, product_id, sku, size, color, price_egp, is_active').order('id').range(a, b),
    ),
    fetchAll<AdSpendRow>((a, b) => supabase.from('ad_spend').select('*').order('from_date', { ascending: false }).order('id').range(a, b)),
    fetchAll<ExpenseRow>((a, b) => supabase.from('expenses').select('*').order('spent_on', { ascending: false }).order('id').range(a, b)),
    fetchAll<{ id: string; expense_id: string; variant_id: string; quantity: number; unit_price_egp: number }>((a, b) =>
      supabase.from('expense_items').select('id, expense_id, variant_id, quantity, unit_price_egp').order('id').range(a, b),
    ),
    supabase.from('profit_settings').select('gift_fund_from, gift_fund_opening_egp, report_hidden').maybeSingle(),
  ]);
  if (settings.error) throw settings.error;

  const byProduct = new Map<string, CostVariant[]>();
  for (const variant of variants) byProduct.set(variant.product_id, [...(byProduct.get(variant.product_id) ?? []), variant]);
  const productList: CostProduct[] = products.map((product) => ({ ...product, variants: byProduct.get(product.id) ?? [] }));

  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const titleById = new Map(products.map((product) => [product.id, product.title]));
  const expenseById = new Map(expenses.map((expense) => [expense.id, expense]));
  const giftPieces: GiftPiece[] = items.flatMap((item) => {
    const expense = expenseById.get(item.expense_id);
    const variant = variantById.get(item.variant_id);
    if (!expense) return [];
    return [
      {
        expense_id: item.expense_id,
        spent_on: expense.spent_on,
        product_id: variant?.product_id ?? null,
        product_title: (variant && titleById.get(variant.product_id)) ?? '—',
        size: variant?.size ?? null,
        color: variant?.color ?? null,
        quantity: item.quantity,
        unit_price_egp: Number(item.unit_price_egp),
      },
    ];
  });

  return {
    sheets: buildSheets(sheets, lines, overrides),
    products: productList,
    ads,
    expenses,
    giftPieces,
    settings: {
      gift_fund_from: settings.data?.gift_fund_from ?? cairoDate(),
      gift_fund_opening_egp: Number(settings.data?.gift_fund_opening_egp ?? 0),
      report_hidden: settings.data?.report_hidden ?? [],
    },
  };
}

export function useProfitBooks(enabled: boolean) {
  return useLoad(() => (enabled ? loadBooks() : Promise.resolve(null)), [enabled]);
}

/** What the courier cost for orders placed in the range - v_profit_courier. */
export function useCourierCosts(range: Range, enabled: boolean) {
  return useLoad(
    () =>
      enabled
        ? fetchAll<CourierCostRow>((a, b) =>
            supabase
              .from('v_profit_courier')
              .select('*')
              .gte('counted_on', range.from)
              .lte('counted_on', range.to)
              .order('line_id')
              .order('kind')
              .range(a, b),
          )
        : Promise.resolve([] as CourierCostRow[]),
    [range.from, range.to, enabled],
  );
}

// --- The day-to-day lists ------------------------------------------------------------------------------

export interface CustodyRow {
  shipment_id: string;
  tracking_number: string | null;
  status: string;
  cod_amount_egp: number | null;
  order_number: string;
  customer_name: string | null;
  governorate: string | null;
  days_in_custody: number;
  units_out: number;
}

export interface ReliabilityRow {
  customer_id: string;
  full_name: string | null;
  phone: string | null;
  orders_placed: number;
  refusals: number;
  refusal_pct: number | null;
  /** Orders taken after the last refusal, on any of their numbers: a refusal made good. */
  received_since_refusal: number;
  requires_prepayment: boolean;
}

export function useCustody(enabled: boolean) {
  return useLoad(async () => {
    if (!enabled) return null;
    const [custody, exceptions, withCouriers] = await Promise.all([
      fetchAll<CustodyRow>((a, b) => supabase.from('v_courier_custody').select('*').order('days_in_custody', { ascending: false }).range(a, b)),
      fetchAll<{ shipment_id: string }>((a, b) => supabase.from('v_custody_exceptions').select('shipment_id').range(a, b)),
      fetchAll<CourierMoneyRow>((a, b) =>
        supabase.from('v_money_with_couriers').select('*').order('days', { ascending: false }).order('shipment_id').range(a, b),
      ),
    ]);
    return { custody, overdue: new Set(exceptions.map((row) => row.shipment_id)), withCouriers };
  }, [enabled]);
}

export function useReliability(enabled: boolean) {
  return useLoad(
    () =>
      enabled
        ? fetchAll<ReliabilityRow>((a, b) =>
            supabase
              .from('v_customer_reliability')
              .select('customer_id, full_name, phone, orders_placed, refusals, refusal_pct, received_since_refusal, requires_prepayment')
              .gt('refusals', 0)
              .order('refusals', { ascending: false })
              .range(a, b),
          )
        : Promise.resolve([] as ReliabilityRow[]),
    [enabled],
  );
}

export function useMoneyIn(range: Range, enabled: boolean) {
  return useLoad(
    () =>
      enabled
        ? fetchAll<MoneyInRow>((a, b) =>
            supabase
              .from('v_report_money_in')
              .select('*')
              .gte('received_on', range.from)
              .lte('received_on', range.to)
              .order('received_on')
              .order('ref_id')
              .range(a, b),
          )
        : Promise.resolve([] as MoneyInRow[]),
    [range.from, range.to, enabled],
  );
}

/** The day before a range, for "everything up to then". */
export const dayBefore = (day: string) => addDays(day, -1);
