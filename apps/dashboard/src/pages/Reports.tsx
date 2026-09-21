import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cairoDate,
  cairoDatePlusDays,
  formatDateTime,
  formatEGP,
  sumMoney,
} from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
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

type Tab = 'summary' | 'log' | 'refusals';

const ACTIVITY_LIMIT = 300;

export function Reports() {
  const { t, locale } = useLocale();

  const [from, setFrom] = useState(() => cairoDatePlusDays(-29));
  const [to, setTo] = useState(() => cairoDate());
  const [tab, setTab] = useState<Tab>('summary');
  const [kind, setKind] = useState<'all' | 'stock' | 'order'>('all');

  const [sales, setSales] = useState<SalesRow[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [refusals, setRefusals] = useState<RefusalRow[] | null>(null);
  const [reliability, setReliability] = useState<ReliabilityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    const [salesResult, activityResult, refusalResult, reliabilityResult] = await Promise.all([
      salesQuery,
      activityQuery,
      refusalQuery,
      reliabilityQuery,
    ]);

    const firstError =
      salesResult.error ?? activityResult.error ?? refusalResult.error ?? reliabilityResult.error;
    if (firstError) {
      setError(firstError.message);
      return;
    }

    setSales((salesResult.data ?? []) as SalesRow[]);
    setActivity((activityResult.data ?? []) as unknown as ActivityRow[]);
    setRefusals((refusalResult.data ?? []) as RefusalRow[]);
    setReliability((reliabilityResult.data ?? []) as ReliabilityRow[]);
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

      <div className="flex gap-2">
        {(['summary', 'log', 'refusals'] as const).map((value) => (
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
      ) : !refusals || !reliability ? (
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
