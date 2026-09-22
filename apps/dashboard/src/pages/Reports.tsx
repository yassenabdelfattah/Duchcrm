import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import {
  cairoDate,
  cairoDatePlusDays,
  can,
  formatDateTime,
  formatEGP,
  sumMoney,
} from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import { Card, EmptyState, ErrorNote, Input, Spinner, cx } from '../components/ui';

/**
 * Looking back.
 *
 * Every stock movement and every order transition has always been recorded,
 * with a person and a reason against it. None of it was reachable: the
 * dashboard showed today's takings and the last twelve movements, so nobody
 * could answer "what happened last Tuesday" or "who adjusted that stock" -
 * which are the questions an append-only ledger exists to answer.
 *
 * Dates are Cairo dates throughout, resolved in SQL. Egypt runs summer time,
 * and a report whose days are off by one is worse than no report.
 */

interface SalesRow {
  sale_date: string;
  channel: string;
  payment_method: string | null;
  order_count: number;
  revenue_egp: number;
  units_sold: number;
}

interface ActivityRow {
  kind: string;
  id: string;
  activity_date: string;
  created_at: string;
  staff_name: string | null;
  action: string;
  quantity_delta: number | null;
  sku: string | null;
  product_title: string | null;
  order_number: string | null;
  location_name: string | null;
  note: string | null;
}

interface RefusalRow {
  month: string;
  outcome: string;
  occurrences: number;
  fees_egp: number | null;
  cost_egp: number | null;
}

interface ReliabilityRow {
  customer_id: string;
  full_name: string | null;
  phone: string | null;
  governorate: string | null;
  requires_prepayment: boolean;
  orders_placed: number;
  delivered: number;
  refusals: number;
  returns_after_delivery: number;
  refusal_pct: number | null;
  last_order_at: string | null;
}

interface CustodyRow {
  shipment_id: string;
  tracking_number: string | null;
  status: string;
  handed_over_at: string | null;
  cod_amount_egp: number | null;
  order_number: string;
  customer_name: string | null;
  governorate: string | null;
  days_in_custody: number;
  units_out: number;
}

interface DiscrepancyRow {
  return_id: string;
  order_number: string;
  tracking_number: string | null;
  sku: string;
  quantity_expected: number;
  quantity_received: number;
  quantity_missing: number;
  condition_note: string | null;
  customer_name: string | null;
  received_at: string | null;
}

interface CohortRow {
  cohort_week: string;
  shipped: number;
  failed_deliveries: number;
  post_delivery_returns: number;
  failed_delivery_pct: number | null;
  post_delivery_pct: number | null;
  is_mature: boolean;
}

interface ValuationRow {
  variant_id: string;
  sku: string;
  product_title: string;
  location_name: string;
  quantity: number;
  cost_egp: number;
  stock_value_egp: number;
}

interface UnsettledRow {
  order_id: string;
  order_number: string;
  total_egp: number;
  shipping_egp: number;
  payment_method: string;
  tracking_number: string | null;
  delivered_at: string | null;
  cod_amount_egp: number | null;
  days_since_delivery: number;
  customer_name: string | null;
}

type Tab = 'summary' | 'log' | 'refusals' | 'custody' | 'cohorts' | 'valuation' | 'unsettled';

const ACTIVITY_LIMIT = 300;

export function Reports() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  // Stock valuation carries cost - the margin - so its tab is hidden from
  // whoever cannot read variant_costs, the same admin/stock_manager pairing
  // used everywhere else cost shows up. The database would already return
  // nothing for anyone else, but showing an always-empty tab is worse than
  // not showing it.
  const mayViewValuation = can(identity?.role, 'stock.adjust');

  const [from, setFrom] = useState(() => cairoDatePlusDays(-29));
  const [to, setTo] = useState(() => cairoDate());
  const [tab, setTab] = useState<Tab>('summary');
  const [kind, setKind] = useState<'all' | 'stock' | 'order'>('all');

  const [sales, setSales] = useState<SalesRow[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [refusals, setRefusals] = useState<RefusalRow[] | null>(null);
  const [reliability, setReliability] = useState<ReliabilityRow[] | null>(null);
  const [custody, setCustody] = useState<CustodyRow[] | null>(null);
  const [overdueIds, setOverdueIds] = useState<Set<string>>(new Set());
  const [shortfalls, setShortfalls] = useState<DiscrepancyRow[] | null>(null);
  const [cohorts, setCohorts] = useState<CohortRow[] | null>(null);
  const [valuation, setValuation] = useState<ValuationRow[] | null>(null);
  const [unsettled, setUnsettled] = useState<UnsettledRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tabs = useMemo(() => {
    const base: Tab[] = ['summary', 'log', 'refusals', 'custody', 'cohorts'];
    if (mayViewValuation) base.push('valuation');
    base.push('unsettled');
    return base;
  }, [mayViewValuation]);

  const load = useCallback(async () => {
    setError(null);

    const salesQuery = supabase
      .from('v_sales_summary_daily')
      .select('*')
      .gte('sale_date', from)
      .lte('sale_date', to)
      .order('sale_date', { ascending: false });

    let activityQuery = supabase
      .from('v_activity_log')
      .select('*')
      .gte('activity_date', from)
      .lte('activity_date', to)
      .order('created_at', { ascending: false })
      .limit(ACTIVITY_LIMIT);

    if (kind !== 'all') activityQuery = activityQuery.eq('kind', kind);

    // Refusal costs are rolled up by month, so the range is widened to whole
    // months rather than silently dropping the month the range starts in.
    const refusalQuery = supabase
      .from('v_refusal_costs')
      .select('*')
      .gte('month', `${from.slice(0, 7)}-01`)
      .lte('month', `${to.slice(0, 7)}-01`)
      .order('month', { ascending: false });

    // Reliability is a lifetime picture of a person, not a period - someone
    // who refused three parcels last year is still worth knowing about.
    const reliabilityQuery = supabase
      .from('v_customer_reliability')
      .select('*')
      .gt('orders_placed', 0)
      .order('refusals', { ascending: false })
      .order('orders_placed', { ascending: false })
      .limit(50);

    // Custody is "right now", not a period: a parcel that has been with the
    // courier for three weeks does not stop mattering because the date range
    // says last month.
    const custodyQuery = supabase
      .from('v_courier_custody')
      .select('*')
      .order('days_in_custody', { ascending: false })
      .limit(200);

    // The same rows the database already decides are overdue. Recomputing
    // the thresholds here would mean two definitions of "too long" that
    // could drift apart.
    const exceptionsQuery = supabase.from('v_custody_exceptions').select('shipment_id');

    const shortfallQuery = supabase
      .from('v_return_discrepancies')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(100);

    // Weeks, not the from/to range: a cohort is only meaningful whole, and
    // the picker above is for sales, not for this.
    const cohortQuery = supabase
      .from('v_return_cohorts')
      .select('*')
      .order('cohort_week', { ascending: false })
      .limit(26);

    // Cost-gated by RLS on variant_costs underneath - a sales or packing
    // login just gets no rows back, per the comment on the view itself.
    const valuationQuery = supabase
      .from('v_stock_valuation')
      .select('*')
      .order('stock_value_egp', { ascending: false })
      .limit(1000);

    // "Right now", the same as custody above - an unsettled order does not
    // stop mattering because the date range says last month.
    const unsettledQuery = supabase
      .from('v_unsettled_orders')
      .select('*')
      .order('days_since_delivery', { ascending: false })
      .limit(200);

    const [
      salesResult,
      activityResult,
      refusalResult,
      reliabilityResult,
      custodyResult,
      exceptionsResult,
      shortfallResult,
      cohortResult,
      valuationResult,
      unsettledResult,
    ] = await Promise.all([
      salesQuery,
      activityQuery,
      refusalQuery,
      reliabilityQuery,
      custodyQuery,
      exceptionsQuery,
      shortfallQuery,
      cohortQuery,
      valuationQuery,
      unsettledQuery,
    ]);

    const firstError =
      salesResult.error ??
      activityResult.error ??
      refusalResult.error ??
      reliabilityResult.error ??
      custodyResult.error ??
      exceptionsResult.error ??
      shortfallResult.error ??
      cohortResult.error ??
      valuationResult.error ??
      unsettledResult.error;
    if (firstError) {
      setError(firstError.message);
      return;
    }

    setSales((salesResult.data ?? []) as SalesRow[]);
    setActivity((activityResult.data ?? []) as unknown as ActivityRow[]);
    setRefusals((refusalResult.data ?? []) as RefusalRow[]);
    setReliability((reliabilityResult.data ?? []) as ReliabilityRow[]);
    setCustody((custodyResult.data ?? []) as CustodyRow[]);
    setOverdueIds(
      new Set((exceptionsResult.data ?? []).map((row) => row.shipment_id as string)),
    );
    setShortfalls((shortfallResult.data ?? []) as DiscrepancyRow[]);
    setCohorts((cohortResult.data ?? []) as CohortRow[]);
    setValuation((valuationResult.data ?? []) as ValuationRow[]);
    setUnsettled((unsettledResult.data ?? []) as UnsettledRow[]);
  }, [from, to, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const rows = sales ?? [];
    return {
      orders: rows.reduce((n, r) => n + Number(r.order_count), 0),
      revenue: sumMoney(rows.map((r) => Number(r.revenue_egp))),
      units: rows.reduce((n, r) => n + Number(r.units_sold), 0),
    };
  }, [sales]);

  /** Rolls the daily rows up by whichever column is asked for. */
  const groupBy = useCallback(
    (key: 'channel' | 'payment_method') => {
      const map = new Map<string, { orders: number; revenue: number }>();
      for (const row of sales ?? []) {
        const k = (row[key] ?? '—') as string;
        const current = map.get(k) ?? { orders: 0, revenue: 0 };
        map.set(k, {
          orders: current.orders + Number(row.order_count),
          revenue: current.revenue + Number(row.revenue_egp),
        });
      }
      return [...map.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
    },
    [sales],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, { orders: number; revenue: number; units: number }>();
    for (const row of sales ?? []) {
      const current = map.get(row.sale_date) ?? { orders: 0, revenue: 0, units: 0 };
      map.set(row.sale_date, {
        orders: current.orders + Number(row.order_count),
        revenue: current.revenue + Number(row.revenue_egp),
        units: current.units + Number(row.units_sold),
      });
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [sales]);

  const busiestDay = useMemo(
    () => byDay.reduce((max, row) => (row[1].revenue > max ? row[1].revenue : max), 0),
    [byDay],
  );

  function applyPreset(days: number) {
    setFrom(cairoDatePlusDays(-(days - 1)));
    setTo(cairoDate());
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold">{t('reports.title')}</h1>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-stone-500">
              {t('reports.from')}
            </span>
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="tabular"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-stone-500">{t('reports.to')}</span>
            <Input
              type="date"
              value={to}
              min={from}
              max={cairoDate()}
              onChange={(event) => setTo(event.target.value)}
              className="tabular"
            />
          </label>
        </div>

        {/* The ranges anyone actually asks for, so the common case is one tap
            rather than two date pickers. */}
        <div className="flex flex-wrap gap-2">
          {[
            { days: 1, key: 'today' },
            { days: 7, key: 'week' },
            { days: 30, key: 'month' },
            { days: 90, key: 'quarter' },
          ].map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => applyPreset(preset.days)}
              className="rounded-lg border border-duch-line px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-50"
            >
              {t(`reports.preset.${preset.key}`)}
            </button>
          ))}
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cx(
              'min-h-11 rounded-lg px-4 text-sm font-semibold transition-colors',
              tab === value
                ? 'bg-duch-ink text-white'
                : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
            )}
          >
            {t(`reports.tab.${value}`)}
          </button>
        ))}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {tab === 'summary' ? (
        !sales ? (
          <Spinner label={t('app.loading')} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('reports.orders')} value={String(totals.orders)} />
              <Stat label={t('reports.revenue')} value={formatEGP(totals.revenue, locale)} />
              <Stat label={t('reports.units')} value={String(totals.units)} />
              <Stat
                label={t('reports.averageOrder')}
                value={formatEGP(
                  totals.orders > 0 ? totals.revenue / totals.orders : 0,
                  locale,
                )}
              />
            </div>

            {byDay.length === 0 ? (
              <EmptyState title={t('reports.noSales')} />
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Breakdown
                    title={t('reports.byChannel')}
                    rows={groupBy('channel').map(([key, value]) => ({
                      label: t(`channel.${key}`),
                      orders: value.orders,
                      revenue: value.revenue,
                    }))}
                    locale={locale}
                    ordersLabel={t('reports.orders')}
                  />
                  <Breakdown
                    title={t('reports.byPayment')}
                    rows={groupBy('payment_method').map(([key, value]) => ({
                      label: key === '—' ? '—' : t(`payment.${key}`),
                      orders: value.orders,
                      revenue: value.revenue,
                    }))}
                    locale={locale}
                    ordersLabel={t('reports.orders')}
                  />
                </div>

                <Card>
                  <h2 className="mb-3 text-sm font-bold">{t('reports.byDay')}</h2>
                  <ul className="space-y-1">
                    {byDay.map(([day, value]) => (
                      <li key={day} className="flex items-center gap-3 text-sm">
                        <span className="tabular w-24 shrink-0 text-xs text-stone-500" dir="ltr">
                          {day}
                        </span>
                        {/* A bar rather than a number alone: the shape of the
                            week is the thing you actually read off this. */}
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                          <span
                            className="block h-full rounded-full bg-duch-ink"
                            style={{
                              width: `${busiestDay > 0 ? (value.revenue / busiestDay) * 100 : 0}%`,
                            }}
                          />
                        </span>
                        <span className="tabular w-16 shrink-0 text-end text-xs text-stone-500">
                          {value.orders}
                        </span>
                        <span className="tabular w-28 shrink-0 text-end font-semibold">
                          {formatEGP(value.revenue, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </>
            )}
          </div>
        )
      ) : tab === 'log' ? (
        !activity ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {(['all', 'stock', 'order'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                  kind === value
                    ? 'bg-duch-ink text-white'
                    : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                )}
              >
                {t(`reports.kind.${value}`)}
              </button>
            ))}
          </div>

          {activity.length === 0 ? (
            <EmptyState title={t('reports.noActivity')} />
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-duch-line text-xs text-stone-500">
                    <th className="py-2 text-start font-bold">{t('reports.when')}</th>
                    <th className="py-2 text-start font-bold">{t('reports.who')}</th>
                    <th className="py-2 text-start font-bold">{t('reports.what')}</th>
                    <th className="py-2 text-start font-bold">{t('reports.item')}</th>
                    <th className="py-2 text-end font-bold">{t('reports.change')}</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((row) => (
                    <tr key={`${row.kind}:${row.id}`} className="border-b border-stone-100">
                      <td className="tabular whitespace-nowrap py-2 text-xs text-stone-500">
                        {formatDateTime(row.created_at, locale)}
                      </td>
                      <td className="py-2">
                        {/* Blank means the system did it - a nightly job, or
                            an import - rather than a person. Saying so is
                            better than an empty cell. */}
                        <bdi>{row.staff_name ?? t('reports.system')}</bdi>
                      </td>
                      <td className="py-2">
                        {describeAction(row, t)}
                      </td>
                      <td className="py-2">
                        {row.order_number ? (
                          <span className="tabular" dir="ltr">
                            {row.order_number}
                          </span>
                        ) : (
                          <span>
                            <bdi className="block">{row.product_title}</bdi>
                            <span className="tabular block text-xs text-stone-500" dir="ltr">
                              {row.sku}
                            </span>
                          </span>
                        )}
                      </td>
                      <td
                        className={cx(
                          'tabular py-2 text-end font-semibold',
                          (row.quantity_delta ?? 0) < 0 ? 'text-red-700' : 'text-emerald-700',
                        )}
                      >
                        {row.quantity_delta === null
                          ? ''
                          : row.quantity_delta > 0
                            ? `+${row.quantity_delta}`
                            : row.quantity_delta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {activity.length >= ACTIVITY_LIMIT ? (
                <p className="pt-3 text-xs text-amber-700">
                  {t('reports.truncated', { count: ACTIVITY_LIMIT })}
                </p>
              ) : null}
            </Card>
          )}
        </div>
      )
      ) : tab === 'refusals' ? (
        !refusals || !reliability ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="space-y-4">
          {/* What refusals actually cost. A refusal pays a full shipping fee
              for a parcel that came back, so this is money spent on nothing -
              the most expensive failure in this business and the one that was
              invisible until now. */}
          <Card>
            <h2 className="mb-1 text-sm font-bold">{t('reports.refusalCost')}</h2>
            <p className="mb-3 text-xs text-stone-500">{t('reports.refusalCostHelp')}</p>

            {refusals.length === 0 ? (
              <p className="text-sm text-stone-500">{t('reports.noRefusals')}</p>
            ) : (
              <>
                <p className="tabular mb-3 text-2xl font-extrabold text-red-700">
                  {formatEGP(
                    sumMoney(refusals.map((row) => Number(row.cost_egp ?? 0))),
                    locale,
                  )}
                </p>
                <ul className="space-y-1 text-sm">
                  {refusals.map((row) => (
                    <li
                      key={`${row.month}:${row.outcome}`}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span>
                        <span className="tabular text-xs text-stone-500" dir="ltr">
                          {row.month.slice(0, 7)}
                        </span>{' '}
                        {t(`settlementOutcome.${row.outcome}`)}
                      </span>
                      <span className="flex items-baseline gap-3">
                        <span className="tabular text-xs text-stone-500">
                          {t('reports.occurrences', { count: row.occurrences })}
                        </span>
                        <span className="tabular font-semibold text-red-700">
                          {formatEGP(Number(row.cost_egp ?? 0), locale)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {/* Who refuses. Not to punish anyone - to decide who should be
              asked to pay up front, which is the one lever that stops a
              refusal costing anything at all. */}
          <Card>
            <h2 className="mb-1 text-sm font-bold">{t('reports.reliability')}</h2>
            <p className="mb-3 text-xs text-stone-500">{t('reports.reliabilityHelp')}</p>

            {reliability.length === 0 ? (
              <p className="text-sm text-stone-500">{t('reports.noCustomers')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-duch-line text-xs text-stone-500">
                      <th className="py-2 text-start font-bold">{t('reports.customer')}</th>
                      <th className="py-2 text-end font-bold">{t('reports.ordersPlaced')}</th>
                      <th className="py-2 text-end font-bold">{t('reports.refused')}</th>
                      <th className="py-2 text-end font-bold">{t('reports.refusalRate')}</th>
                      <th className="py-2 text-end font-bold">{t('reports.prepay')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reliability.map((row) => {
                      const pct = Number(row.refusal_pct ?? 0);
                      return (
                        <tr key={row.customer_id} className="border-b border-stone-100">
                          <td className="py-2">
                            <bdi className="block font-semibold">{row.full_name ?? '—'}</bdi>
                            <span className="tabular block text-xs text-stone-500" dir="ltr">
                              {row.phone ?? ''}
                            </span>
                          </td>
                          <td className="tabular py-2 text-end">{row.orders_placed}</td>
                          <td className="tabular py-2 text-end font-semibold">{row.refusals}</td>
                          <td
                            className={cx(
                              'tabular py-2 text-end font-semibold',
                              // A third of orders coming back is a pattern,
                              // not bad luck.
                              pct >= 33 ? 'text-red-700' : pct > 0 ? 'text-amber-700' : '',
                            )}
                          >
                            {pct > 0 ? `${pct}%` : '—'}
                          </td>
                          <td className="py-2 text-end text-xs">
                            {row.requires_prepayment ? t('reports.prepayYes') : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )
      ) : tab === 'custody' ? (
      !custody || !shortfalls ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="space-y-4">
          {/* How much is outside the building right now. Not a report about
              the past - a count of goods somebody else is holding. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('custody.parcels')} value={String(custody.length)} />
            <Stat
              label={t('custody.units')}
              value={String(custody.reduce((n, r) => n + Number(r.units_out), 0))}
            />
            <Stat
              label={t('custody.value')}
              value={formatEGP(
                sumMoney(custody.map((r) => Number(r.cod_amount_egp ?? 0))),
                locale,
              )}
            />
            <Stat label={t('custody.overdue')} value={String(overdueIds.size)} />
          </div>

          {/* Delivery takes three to five days and a refusal comes back
              within two or three. Anything on this list has stopped moving,
              and the owner has said plainly that this - not the courier's
              own tracking - is the control he cares about. */}
          {overdueIds.size > 0 ? (
            <Card className="border-red-200 bg-red-50">
              <h2 className="mb-1 text-sm font-bold text-red-900">{t('custody.overdueTitle')}</h2>
              <p className="mb-3 text-xs text-red-800">{t('custody.overdueHelp')}</p>
              <ul className="space-y-2">
                {custody
                  .filter((row) => overdueIds.has(row.shipment_id))
                  .map((row) => (
                    <li
                      key={row.shipment_id}
                      className="flex flex-wrap items-baseline gap-3 text-sm"
                    >
                      <span className="tabular font-extrabold" dir="ltr">
                        {row.tracking_number ?? '—'}
                      </span>
                      <span className="tabular text-xs text-stone-600" dir="ltr">
                        {row.order_number}
                      </span>
                      <span className="min-w-0 flex-1 text-xs">
                        <bdi>{row.customer_name ?? '—'}</bdi>
                      </span>
                      <span className="text-xs">{t(`fulfillment.${row.status}`)}</span>
                      <span className="tabular font-bold text-red-700">
                        {t('custody.days', { count: Math.floor(row.days_in_custody) })}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <h2 className="mb-3 text-sm font-bold">{t('custody.allTitle')}</h2>
            {custody.length === 0 ? (
              <p className="text-sm text-stone-500">{t('custody.none')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-duch-line text-xs text-stone-500">
                      <th className="py-2 text-start font-bold">{t('queue.trackingNumber')}</th>
                      <th className="py-2 text-start font-bold">{t('reports.customer')}</th>
                      <th className="py-2 text-start font-bold">{t('custody.state')}</th>
                      <th className="py-2 text-end font-bold">{t('custody.unitsShort')}</th>
                      <th className="py-2 text-end font-bold">{t('custody.withThem')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {custody.map((row) => {
                      const late = overdueIds.has(row.shipment_id);
                      return (
                        <tr key={row.shipment_id} className="border-b border-stone-100">
                          <td className="tabular py-2" dir="ltr">
                            {row.tracking_number ?? '—'}
                            <span className="block text-xs text-stone-500">
                              {row.order_number}
                            </span>
                          </td>
                          <td className="py-2">
                            <bdi>{row.customer_name ?? '—'}</bdi>
                            <span className="block text-xs text-stone-500">
                              <bdi>{row.governorate ?? ''}</bdi>
                            </span>
                          </td>
                          <td className="py-2 text-xs">{t(`fulfillment.${row.status}`)}</td>
                          <td className="tabular py-2 text-end">{row.units_out}</td>
                          <td
                            className={cx(
                              'tabular py-2 text-end font-semibold',
                              late ? 'text-red-700' : '',
                            )}
                          >
                            {t('custody.days', { count: Math.floor(row.days_in_custody) })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* A parcel that came back short. Not a suspicion like the aged
              list above - a counted shortfall, recorded at check-in. */}
          <Card className={shortfalls.length > 0 ? 'border-red-200' : undefined}>
            <h2 className="mb-1 text-sm font-bold">{t('custody.shortTitle')}</h2>
            <p className="mb-3 text-xs text-stone-500">{t('custody.shortHelp')}</p>
            {shortfalls.length === 0 ? (
              <p className="text-sm text-stone-500">{t('custody.noShort')}</p>
            ) : (
              <ul className="space-y-2">
                {shortfalls.map((row) => (
                  <li
                    key={`${row.return_id}:${row.sku}`}
                    className="flex flex-wrap items-baseline gap-3 text-sm"
                  >
                    <span className="tabular font-semibold" dir="ltr">
                      {row.sku}
                    </span>
                    <span className="tabular text-xs text-stone-500" dir="ltr">
                      {row.order_number}
                    </span>
                    <span className="min-w-0 flex-1 text-xs">
                      <bdi>{row.condition_note ?? ''}</bdi>
                    </span>
                    <span className="tabular font-bold text-red-700">
                      {t('custody.missing', { count: row.quantity_missing })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )
      ) : tab === 'cohorts' ? (
        !cohorts ? (
          <Spinner label={t('app.loading')} />
        ) : cohorts.length === 0 ? (
          <EmptyState title={t('reports.noCohorts')} />
        ) : (
          <Card className="overflow-x-auto">
            <h2 className="mb-1 text-sm font-bold">{t('reports.cohortsTitle')}</h2>
            <p className="mb-3 text-xs text-stone-500">{t('reports.cohortsHelp')}</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-duch-line text-xs text-stone-500">
                  <th className="py-2 text-start font-bold">{t('reports.cohortWeek')}</th>
                  <th className="py-2 text-end font-bold">{t('reports.cohortShipped')}</th>
                  <th className="py-2 text-end font-bold">{t('reports.cohortFailed')}</th>
                  <th className="py-2 text-end font-bold">{t('reports.cohortReturned')}</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.map((row) => (
                  <tr key={row.cohort_week} className="border-b border-stone-100">
                    <td className="tabular py-2" dir="ltr">
                      {row.cohort_week}
                      {!row.is_mature ? (
                        <span className="ms-2">
                          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-500">
                            {t('reports.cohortStillMoving')}
                          </span>
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular py-2 text-end">{row.shipped}</td>
                    <td className="tabular py-2 text-end font-semibold">
                      {row.failed_deliveries}
                      {row.failed_delivery_pct !== null ? (
                        <span className="ms-1 text-xs text-stone-500">
                          ({row.failed_delivery_pct}%)
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular py-2 text-end font-semibold">
                      {row.post_delivery_returns}
                      {row.post_delivery_pct !== null ? (
                        <span className="ms-1 text-xs text-stone-500">
                          ({row.post_delivery_pct}%)
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )
      ) : tab === 'valuation' ? (
        !valuation ? (
          <Spinner label={t('app.loading')} />
        ) : valuation.length === 0 ? (
          <EmptyState title={t('reports.noValuation')} />
        ) : (
          <div className="space-y-4">
            <Stat
              label={t('reports.valuationTotal')}
              value={formatEGP(
                sumMoney(valuation.map((row) => Number(row.stock_value_egp))),
                locale,
              )}
            />
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-duch-line bg-stone-50 text-xs uppercase text-stone-500">
                  <tr>
                    <th className="px-4 py-3 text-start font-semibold">{t('stock.product')}</th>
                    <th className="px-4 py-3 text-start font-semibold">{t('stock.sku')}</th>
                    <th className="px-4 py-3 text-end font-semibold">{t('stock.quantity')}</th>
                    <th className="px-4 py-3 text-end font-semibold">{t('reports.valuationCost')}</th>
                    <th className="px-4 py-3 text-end font-semibold">{t('reports.valuationValue')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-duch-line">
                  {valuation.map((row) => (
                    <tr key={`${row.variant_id}`}>
                      <td className="px-4 py-3">
                        <bdi className="block font-semibold">{row.product_title}</bdi>
                        <span className="text-xs text-stone-500">{row.location_name}</span>
                      </td>
                      <td className="tabular px-4 py-3" dir="ltr">
                        {row.sku}
                      </td>
                      <td className="tabular px-4 py-3 text-end">{row.quantity}</td>
                      <td className="tabular px-4 py-3 text-end">
                        {formatEGP(Number(row.cost_egp), locale)}
                      </td>
                      <td className="tabular px-4 py-3 text-end font-semibold">
                        {formatEGP(Number(row.stock_value_egp), locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )
      ) : !unsettled ? (
        <Spinner label={t('app.loading')} />
      ) : unsettled.length === 0 ? (
        <EmptyState title={t('reports.noUnsettled')} />
      ) : (
        <div className="space-y-4">
          {/* Delivered, but the money has not landed on a settlement yet.
              Not a period report - the age of the oldest row here is the
              thing that matters, so it sorts to the top. */}
          <Stat
            label={t('reports.unsettledTotal')}
            value={formatEGP(
              sumMoney(unsettled.map((row) => Number(row.total_egp))),
              locale,
            )}
          />
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-duch-line bg-stone-50 text-xs uppercase text-stone-500">
                <tr>
                  <th className="px-4 py-3 text-start font-semibold">{t('orders.title')}</th>
                  <th className="px-4 py-3 text-start font-semibold">{t('reports.customer')}</th>
                  <th className="px-4 py-3 text-start font-semibold">{t('sale.paymentMethod')}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t('reports.unsettledAmount')}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t('custody.withThem')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-duch-line">
                {unsettled.map((row) => (
                  <tr key={row.order_id}>
                    <td className="tabular px-4 py-3" dir="ltr">
                      {row.order_number}
                      <span className="block text-xs text-stone-500">
                        {row.tracking_number ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <bdi>{row.customer_name ?? '—'}</bdi>
                    </td>
                    <td className="px-4 py-3 text-xs">{t(`payment.${row.payment_method}`)}</td>
                    <td className="tabular px-4 py-3 text-end font-semibold">
                      {formatEGP(Number(row.cod_amount_egp ?? row.total_egp), locale)}
                    </td>
                    <td
                      className={cx(
                        'tabular px-4 py-3 text-end font-semibold',
                        row.days_since_delivery > 7 ? 'text-red-700' : '',
                      )}
                    >
                      {t('custody.days', { count: Math.floor(row.days_since_delivery) })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * What happened, in words.
 *
 * A stock row carries a movement reason. An order row carries whatever
 * changed, which is a fulfillment status for most transitions and a payment
 * status for the rest - and the two enums do not overlap, so trying them in
 * turn is enough to tell them apart. `t` returns the key it was given when
 * there is no translation, which is what makes that check work.
 */
function describeAction(
  row: ActivityRow,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (row.kind === 'stock') return t(`reason.${row.action}`);

  const asFulfillment = t(`fulfillment.${row.action}`);
  if (asFulfillment !== `fulfillment.${row.action}`) return asFulfillment;

  const asPayment = t(`paymentStatus.${row.action}`);
  if (asPayment !== `paymentStatus.${row.action}`) return asPayment;

  return row.action;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-xs font-bold text-stone-500">{label}</p>
      <p className="tabular mt-1 text-xl font-extrabold">{value}</p>
    </Card>
  );
}

function Breakdown({
  title,
  rows,
  locale,
  ordersLabel,
}: {
  title: string;
  rows: Array<{ label: string; orders: number; revenue: number }>;
  locale: 'ar' | 'en';
  ordersLabel: string;
}) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-bold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">—</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-3 text-sm">
              <span>{row.label}</span>
              <span className="flex items-baseline gap-3">
                <span className="tabular text-xs text-stone-500">
                  {row.orders} {ordersLabel}
                </span>
                <span className="tabular font-semibold">{formatEGP(row.revenue, locale)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
