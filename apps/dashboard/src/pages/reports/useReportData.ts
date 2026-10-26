import { useEffect, useState } from 'react';
import { cairoDate } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { addDays, previousRange, type Range, type ReportOrder, type ReturnLine, type SaleLine, type StockItem } from '../../lib/reportMath';

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

export interface OwedRow {
  order_id: string;
  order_number: string;
  fulfillment_status: string;
  total_egp: number;
  tracking_number: string | null;
  days_waiting: number;
  customer_name: string | null;
}

export interface StatementRow {
  id: string;
  reference: string | null;
  received_at: string | null;
  status: string;
  net_received_egp: number | null;
  collected_egp: number;
  fees_egp: number;
  net_egp: number;
  delivered_count: number;
  return_count: number;
}

export interface StatementLineRow {
  settlement_id: string;
  received_at: string | null;
  outcome: string;
  fee_egp: number;
  shipping_gain_egp: number | null;
}

export interface TakenOutRow {
  id: string;
  reason: string;
  reason_text: string | null;
  taken_by: string | null;
  note: string | null;
  created_at: string;
  return_by: string | null;
  status: string;
  quantity: number;
  outstanding: number;
}

export interface ReliabilityRow {
  customer_id: string;
  full_name: string | null;
  phone: string | null;
  orders_placed: number;
  refusals: number;
  refusal_pct: number | null;
  requires_prepayment: boolean;
}

export interface ReportData {
  lines: SaleLine[];
  returns: ReturnLine[];
  orders: ReportOrder[];
  custody: CustodyRow[];
  overdue: Set<string>;
  owed: OwedRow[];
  statements: StatementRow[];
  statementLines: StatementLineRow[];
  stock: StockItem[];
  takenOut: TakenOutRow[];
  reliability: ReliabilityRow[];
}

/** The API returns at most 1,000 rows a request; a quarter of order lines can be more. */
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

/**
 * Everything the reports read for a range: the range and the one before it,
 * for comparing, and the last 30 days, for how fast stock is selling. Kept
 * while a new range loads, so the page holds its shape instead of flashing.
 */
export function useReportData(range: Range) {
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const today = cairoDate();
    const from = [previousRange(range).from, addDays(today, -29)].sort()[0]!;
    const to = [range.to, today].sort()[1]!;

    async function load() {
      setLoading(true);
      try {
        const [lines, returns, orders, custody, exceptions, owed, statements, statementLines, stock, takenOut, reliability] =
          await Promise.all([
            fetchAll<SaleLine>((a, b) =>
              supabase.from('v_report_lines').select('*').gte('placed_on', from).lte('placed_on', to).order('line_id').range(a, b),
            ),
            fetchAll<ReturnLine>((a, b) =>
              supabase.from('v_report_returns').select('*').gte('returned_on', from).lte('returned_on', to).order('return_line_id').range(a, b),
            ),
            fetchAll<ReportOrder>((a, b) =>
              supabase.from('v_report_orders').select('*').gte('placed_on', from).lte('placed_on', to).order('order_id').range(a, b),
            ),
            fetchAll<CustodyRow>((a, b) => supabase.from('v_courier_custody').select('*').order('days_in_custody', { ascending: false }).range(a, b)),
            fetchAll<{ shipment_id: string }>((a, b) => supabase.from('v_custody_exceptions').select('shipment_id').range(a, b)),
            fetchAll<OwedRow>((a, b) => supabase.from('v_awaiting_settlement').select('*').order('days_waiting', { ascending: false }).range(a, b)),
            fetchAll<StatementRow>((a, b) =>
              supabase.from('v_settlements').select('*').gte('received_at', range.from).lte('received_at', range.to).order('received_at', { ascending: false }).range(a, b),
            ),
            fetchAll<StatementLineRow>((a, b) =>
              supabase
                .from('v_settlement_statement')
                .select('settlement_id, received_at, outcome, fee_egp, shipping_gain_egp')
                .gte('received_at', range.from)
                .lte('received_at', range.to)
                .order('line_id')
                .range(a, b),
            ),
            fetchAll<StockItem & { is_active: boolean; track_inventory: boolean }>((a, b) =>
              supabase
                .from('v_stock_overview')
                .select('variant_id, sku, product_title, size, color, quantity, is_active, track_inventory')
                .order('variant_id')
                .range(a, b),
            ),
            fetchAll<TakenOutRow>((a, b) => supabase.from('v_stock_outs').select('*').order('created_at', { ascending: false }).range(a, b)),
            fetchAll<ReliabilityRow>((a, b) =>
              supabase
                .from('v_customer_reliability')
                .select('customer_id, full_name, phone, orders_placed, refusals, refusal_pct, requires_prepayment')
                .gt('refusals', 0)
                .order('refusals', { ascending: false })
                .range(a, b),
            ),
          ]);

        // One row per piece, whatever shelf it is on.
        const byVariant = new Map<string, StockItem>();
        for (const row of stock) {
          if (!row.is_active || !row.track_inventory) continue;
          const current = byVariant.get(row.variant_id);
          if (current) current.quantity += Number(row.quantity);
          else
            byVariant.set(row.variant_id, {
              variant_id: row.variant_id,
              sku: row.sku,
              product_title: row.product_title,
              size: row.size,
              color: row.color,
              quantity: Number(row.quantity),
            });
        }

        if (cancelled) return;
        setData({
          lines,
          returns,
          orders,
          custody,
          overdue: new Set(exceptions.map((row) => row.shipment_id)),
          owed,
          statements,
          statementLines,
          stock: [...byVariant.values()],
          takenOut,
          reliability,
        });
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(arabicError(caught as { message?: string; code?: string }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}
