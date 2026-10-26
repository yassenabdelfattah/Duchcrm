import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { cairoDate, formatDate, formatEGP, sumMoney } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import {
  byChannel,
  byColor,
  byDay,
  byGovernorate,
  byPayment,
  byProduct,
  bySize,
  byVariant,
  change,
  customers,
  daysBetween,
  previousRange,
  returnsByReason,
  rollUp,
  stockHealth,
  summarize,
  type DayPoint,
  type GroupRow,
  type ItemRow,
  type Range,
  type StockHealthRow,
} from '../../lib/reportMath';
import { useLocale } from '../../i18n';
import { BarList, TrendChart } from '../../components/charts';
import { Card, cx } from '../../components/ui';
import { DataTable, Panel, Segmented, StatTile, percent, wholeEGP, type Column } from './parts';
import type { ReportData } from './useReportData';

type T = (key: string, params?: Record<string, unknown>) => string;

/** The reports, by what they answer. */
export const REPORT_GROUPS = [
  { key: 'sales', reports: ['sales', 'products', 'sizes', 'channels'] },
  { key: 'areas', reports: ['governorates', 'refusals'] },
  { key: 'money', reports: ['courier', 'owed', 'statements'] },
  { key: 'stock', reports: ['stock', 'takenOut', 'customers', 'valuation'] },
] as const;

export type ReportKey = (typeof REPORT_GROUPS)[number]['reports'][number];

const orderLink = (orderNumber: string) => (
  <Link
    to={`/orders?q=${encodeURIComponent(orderNumber)}`}
    className="tabular font-semibold underline decoration-stone-300 underline-offset-2"
    dir="ltr"
  >
    {orderNumber}
  </Link>
);

/** "12%" up or down - or, for a rate, the change in points. */
function deltaText(value: number | null, t: T, points = false): string {
  if (value === null) return t('analytics.noCompare');
  const shown = Math.abs(Math.round(value * 100));
  return points ? t('analytics.points', { count: shown }) : `${shown}%`;
}

/** The daily figure lined up against the same day of the period before. */
function trendPoints(current: DayPoint[], previous: DayPoint[], pick: (point: DayPoint) => number, locale: 'ar' | 'en') {
  return current.map((point, index) => ({
    label: point.day.length === 7 ? point.day : formatDate(point.day, locale).replace(/\/\d{4}$/, ''),
    value: pick(point),
    previous: previous[index] ? pick(previous[index]!) : undefined,
    previousLabel: previous[index]
      ? previous[index]!.day.length === 7
        ? previous[index]!.day
        : formatDate(previous[index]!.day, locale).replace(/\/\d{4}$/, '')
      : undefined,
  }));
}

// --- Home --------------------------------------------------------------------------------------

export function ReportsHome({
  data,
  range,
  mayViewValuation,
  onOpen,
}: {
  data: ReportData;
  range: Range;
  mayViewValuation: boolean;
  onOpen: (key: ReportKey) => void;
}) {
  const { t, locale } = useLocale();
  const previous = previousRange(range);
  const now = summarize(data.lines, data.returns, data.orders, range);
  const before = summarize(data.lines, data.returns, data.orders, previous);
  const days = byDay(data.lines, data.returns, data.orders, range);
  const daysBefore = byDay(data.lines, data.returns, data.orders, previous);
  // Long ranges read better by the week.
  const grain = daysBetween(range.from, range.to) > 62 ? 'week' : 'day';
  const products = byProduct(data.lines, data.returns, range).slice(0, 5);
  const areas = byGovernorate(data.orders, range).slice(0, 5);

  const withCourier = sumMoney(data.custody.map((row) => Number(row.cod_amount_egp ?? 0)));
  const owed = sumMoney(data.owed.filter((row) => row.fulfillment_status === 'delivered').map((row) => Number(row.total_egp)));

  const rateDelta = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('analytics.kpi.net')}
          value={wholeEGP(now.net, locale)}
          delta={change(now.net, before.net)}
          deltaLabel={deltaText(change(now.net, before.net), t)}
          trend={rollUp(days, grain).map((point) => point.net)}
        />
        <StatTile
          label={t('analytics.kpi.orders')}
          value={String(now.orders)}
          delta={change(now.orders, before.orders)}
          deltaLabel={deltaText(change(now.orders, before.orders), t)}
          trend={rollUp(days, grain).map((point) => point.orders)}
        />
        <StatTile
          label={t('analytics.kpi.averageOrder')}
          value={wholeEGP(now.averageOrder, locale)}
          delta={change(now.averageOrder, before.averageOrder)}
          deltaLabel={deltaText(change(now.averageOrder, before.averageOrder), t)}
        />
        <StatTile
          label={t('analytics.kpi.units')}
          value={String(now.units)}
          delta={change(now.units, before.units)}
          deltaLabel={deltaText(change(now.units, before.units), t)}
        />
        <StatTile
          label={t('analytics.kpi.deliveryRate')}
          value={percent(now.deliveryRate)}
          delta={rateDelta(now.deliveryRate, before.deliveryRate)}
          deltaLabel={deltaText(rateDelta(now.deliveryRate, before.deliveryRate), t, true)}
        />
        <StatTile
          label={t('analytics.kpi.refusalRate')}
          value={percent(now.refusalRate)}
          delta={rateDelta(now.refusalRate, before.refusalRate)}
          deltaLabel={deltaText(rateDelta(now.refusalRate, before.refusalRate), t, true)}
          upIsGood={false}
        />
        <StatTile
          label={t('analytics.kpi.withCourier')}
          value={wholeEGP(withCourier, locale)}
          hint={t('analytics.parcelsNow', { count: data.custody.length })}
        />
        <StatTile
          label={t('analytics.kpi.owed')}
          value={wholeEGP(owed, locale)}
          hint={t('analytics.ordersNow', { count: data.owed.filter((row) => row.fulfillment_status === 'delivered').length })}
        />
      </div>

      <Panel
        title={t('analytics.netOverTime')}
        help={t('analytics.netHelp')}
        action={<OpenLink onClick={() => onOpen('sales')} />}
      >
        <TrendChart
          points={trendPoints(rollUp(days, grain), rollUp(daysBefore, grain), (point) => point.net, locale)}
          format={(value) => wholeEGP(value, locale)}
          currentLabel={t('analytics.thisPeriod')}
          previousLabel={t('analytics.previousPeriod')}
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={t('analytics.topProducts')} action={<OpenLink onClick={() => onOpen('products')} />}>
          <BarList
            rows={products.map((row) => ({
              key: row.key,
              label: <bdi>{row.label}</bdi>,
              value: row.net,
              note: t('analytics.pieces', { count: row.units }),
            }))}
            format={(value) => wholeEGP(value, locale)}
            empty={t('analytics.empty')}
          />
        </Panel>
        <Panel title={t('analytics.topAreas')} action={<OpenLink onClick={() => onOpen('governorates')} />}>
          <BarList
            rows={areas.map((row) => ({
              key: row.key,
              label: <bdi>{row.key === '—' ? t('analytics.unknownArea') : row.key}</bdi>,
              value: row.orders,
              note: row.refusalRate !== null ? t('analytics.refusedShort', { rate: percent(row.refusalRate) }) : undefined,
            }))}
            format={(value) => String(value)}
            empty={t('analytics.empty')}
          />
        </Panel>
      </div>

      {REPORT_GROUPS.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="text-sm font-bold text-stone-500">{t(`analytics.group.${group.key}`)}</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {group.reports
              .filter((key) => key !== 'valuation' || mayViewValuation)
              .map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onOpen(key)}
                  className="rounded-xl border border-duch-line bg-white p-3 text-start transition-colors hover:border-stone-400"
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-bold">
                    {t(`analytics.report.${key}.title`)}
                    <ChevronLeft className="h-4 w-4 text-stone-400 ltr:rotate-180" aria-hidden />
                  </span>
                  <span className="mt-1 block text-xs text-stone-500">{t(`analytics.report.${key}.help`)}</span>
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function OpenLink({ onClick }: { onClick: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" onClick={onClick} className="text-xs font-semibold text-duch-accent hover:underline">
      {t('analytics.details')}
    </button>
  );
}

// --- One report --------------------------------------------------------------------------------

export function ReportView({ report, data, range }: { report: ReportKey; data: ReportData; range: Range }) {
  switch (report) {
    case 'sales':
      return <SalesReport data={data} range={range} />;
    case 'products':
      return <ProductsReport data={data} range={range} initial="product" />;
    case 'sizes':
      return <ProductsReport data={data} range={range} initial="size" />;
    case 'channels':
      return <ChannelsReport data={data} range={range} />;
    case 'governorates':
      return <GovernoratesReport data={data} range={range} />;
    case 'refusals':
      return <RefusalsReport data={data} range={range} />;
    case 'courier':
      return <CourierReport data={data} />;
    case 'owed':
      return <OwedReport data={data} />;
    case 'statements':
      return <StatementsReport data={data} />;
    case 'stock':
      return <StockReport data={data} />;
    case 'takenOut':
      return <TakenOutReport data={data} />;
    case 'customers':
      return <CustomersReport data={data} range={range} />;
    case 'valuation':
      return <ValuationReport />;
  }
}

function SalesReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  const [grain, setGrain] = useState<'day' | 'week' | 'month'>(daysBetween(range.from, range.to) > 62 ? 'week' : 'day');
  const points = rollUp(byDay(data.lines, data.returns, data.orders, range), grain);
  const before = rollUp(byDay(data.lines, data.returns, data.orders, previousRange(range)), grain);
  const total = summarize(data.lines, data.returns, data.orders, range);
  const money = (value: number) => formatEGP(value, locale);
  // Shown as money taken off, without a "-0.00" where nothing was.
  const less = (value: number) => (value === 0 ? money(0) : money(-value));

  const columns: Column<DayPoint>[] = [
    {
      key: 'day',
      label: t(`analytics.grain.${grain}`),
      value: (row) => row.day,
      render: (row) => (
        <span className="tabular" dir="ltr">
          {row.day.length === 7 ? row.day : formatDate(row.day, locale)}
        </span>
      ),
    },
    { key: 'orders', label: t('analytics.col.orders'), value: (row) => row.orders, numeric: true },
    { key: 'units', label: t('analytics.col.units'), value: (row) => row.units, numeric: true },
    { key: 'gross', label: t('analytics.col.gross'), value: (row) => row.gross, render: (row) => money(row.gross), numeric: true },
    { key: 'discounts', label: t('analytics.col.discounts'), value: (row) => row.discounts, render: (row) => less(row.discounts), numeric: true },
    { key: 'returns', label: t('analytics.col.returns'), value: (row) => row.returns, render: (row) => less(row.returns), numeric: true },
    {
      key: 'net',
      label: t('analytics.col.net'),
      value: (row) => row.net,
      render: (row) => <span className="font-semibold">{money(row.net)}</span>,
      numeric: true,
    },
  ];

  return (
    <div className="space-y-4">
      {/* How the headline is made, the way Shopify shows it. */}
      <Card>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Line label={t('analytics.col.gross')} value={money(total.gross)} />
          <Line label={t('analytics.col.discounts')} value={less(total.discounts)} />
          <Line label={t('analytics.col.returns')} value={less(total.returns)} />
          <Line label={t('analytics.col.net')} value={money(total.net)} strong />
        </dl>
      </Card>

      <Panel
        title={t('analytics.netOverTime')}
        action={
          <Segmented
            value={grain}
            onChange={setGrain}
            options={(['day', 'week', 'month'] as const).map((value) => ({ value, label: t(`analytics.grain.${value}`) }))}
          />
        }
      >
        <TrendChart
          points={trendPoints(points, before, (point) => point.net, locale)}
          format={(value) => wholeEGP(value, locale)}
          currentLabel={t('analytics.thisPeriod')}
          previousLabel={t('analytics.previousPeriod')}
        />
      </Panel>

      <Panel title={t('analytics.table')}>
        <DataTable
          columns={columns}
          rows={[...points].reverse()}
          rowKey={(row) => row.day}
          fileName={`sales-${range.from}-${range.to}`}
          totals={{
            orders: total.orders,
            units: total.units,
            gross: money(total.gross),
            discounts: less(total.discounts),
            returns: less(total.returns),
            net: money(total.net),
          }}
        />
      </Panel>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3', strong && 'font-extrabold')}>
      <dt className={strong ? '' : 'text-stone-500'}>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

function ProductsReport({ data, range, initial }: { data: ReportData; range: Range; initial: 'product' | 'variant' | 'size' | 'color' }) {
  const { t, locale } = useLocale();
  const [view, setView] = useState(initial);
  const rows =
    view === 'product'
      ? byProduct(data.lines, data.returns, range)
      : view === 'variant'
        ? byVariant(data.lines, data.returns, range)
        : view === 'size'
          ? bySize(data.lines, data.returns, range)
          : byColor(data.lines, data.returns, range);
  const byUnits = view === 'size' || view === 'color';

  const columns: Column<ItemRow>[] = [
    {
      key: 'label',
      label: t(`analytics.view.${view}`),
      value: (row) => [row.label, row.detail].filter(Boolean).join(' · '),
      render: (row) => (
        <span className="block min-w-40">
          <bdi className="block font-semibold">{row.label}</bdi>
          {row.detail || row.sku ? (
            <span className="flex flex-wrap gap-x-2 text-xs text-stone-500">
              {row.detail ? <bdi>{row.detail}</bdi> : null}
              {row.sku ? (
                <span className="tabular" dir="ltr">
                  {row.sku}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'units', label: t('analytics.col.unitsSold'), value: (row) => row.units, numeric: true },
    { key: 'back', label: t('analytics.col.unitsBack'), value: (row) => row.unitsReturned, numeric: true },
    { key: 'rate', label: t('analytics.col.returnRate'), value: (row) => row.returnRate, render: (row) => percent(row.returnRate), numeric: true },
    { key: 'net', label: t('analytics.col.net'), value: (row) => row.net, render: (row) => formatEGP(row.net, locale), numeric: true },
  ];

  return (
    <div className="space-y-4">
      <Segmented
        value={view}
        onChange={setView}
        options={(['product', 'variant', 'size', 'color'] as const).map((value) => ({ value, label: t(`analytics.view.${value}`) }))}
      />
      <Panel title={t(byUnits ? 'analytics.mostPieces' : 'analytics.mostSales')}>
        <BarList
          rows={(byUnits ? [...rows].sort((a, b) => b.units - a.units) : rows).slice(0, 10).map((row) => ({
            key: row.key,
            label: (
              <span className="flex flex-wrap items-baseline gap-x-2">
                <bdi>{row.label}</bdi>
                {row.detail ? <bdi className="text-xs text-stone-500">{row.detail}</bdi> : null}
              </span>
            ),
            value: byUnits ? row.units : row.net,
            note: byUnits ? undefined : t('analytics.pieces', { count: row.units }),
          }))}
          format={(value) => (byUnits ? t('analytics.pieces', { count: value }) : wholeEGP(value, locale))}
          empty={t('analytics.empty')}
        />
      </Panel>
      <Panel title={t('analytics.table')}>
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.key} fileName={`products-${view}-${range.from}-${range.to}`} limit={50} />
      </Panel>
    </div>
  );
}

function groupColumns(t: T, locale: 'ar' | 'en', first: Column<GroupRow>): Column<GroupRow>[] {
  return [
    first,
    { key: 'orders', label: t('analytics.col.orders'), value: (row) => row.orders, numeric: true },
    { key: 'value', label: t('analytics.col.ordered'), value: (row) => row.value, render: (row) => formatEGP(row.value, locale), numeric: true },
    { key: 'average', label: t('analytics.col.average'), value: (row) => row.averageOrder, render: (row) => formatEGP(row.averageOrder, locale), numeric: true },
    { key: 'delivered', label: t('analytics.col.delivered'), value: (row) => row.delivered + row.returnedAfterDelivery, numeric: true },
    { key: 'refused', label: t('analytics.col.refused'), value: (row) => row.refused, numeric: true },
    {
      key: 'refusalRate',
      label: t('analytics.col.refusalRate'),
      value: (row) => row.refusalRate,
      render: (row) => (
        <span className={cx((row.refusalRate ?? 0) >= 0.3 && 'font-bold text-red-700')}>{percent(row.refusalRate)}</span>
      ),
      numeric: true,
    },
    { key: 'open', label: t('analytics.col.open'), value: (row) => row.open, numeric: true },
  ];
}

function ChannelsReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  return (
    <div className="space-y-4">
      <Panel title={t('analytics.byChannel')}>
        <DataTable
          columns={groupColumns(t, locale, {
            key: 'key',
            label: t('analytics.col.channel'),
            value: (row) => t(`channel.${row.key}`),
          })}
          rows={byChannel(data.orders, range)}
          rowKey={(row) => row.key}
          fileName={`channels-${range.from}-${range.to}`}
        />
      </Panel>
      <Panel title={t('analytics.byPayment')}>
        <DataTable
          columns={groupColumns(t, locale, {
            key: 'key',
            label: t('analytics.col.payment'),
            value: (row) => (row.key === '—' ? '—' : t(`payment.${row.key}`)),
          })}
          rows={byPayment(data.orders, range)}
          rowKey={(row) => row.key}
          fileName={`payments-${range.from}-${range.to}`}
        />
      </Panel>
    </div>
  );
}

function GovernoratesReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  const rows = byGovernorate(data.orders, range);
  const unknown = rows.find((row) => row.key === '—');
  const totalOrders = rows.reduce((total, row) => total + row.orders, 0);
  return (
    <div className="space-y-4">
      <Panel title={t('analytics.ordersByArea')} help={t('analytics.areaHelp')}>
        <BarList
          rows={rows
            .filter((row) => row.key !== '—')
            .slice(0, 12)
            .map((row) => ({
              key: row.key,
              label: <bdi>{row.key}</bdi>,
              value: row.orders,
              note: row.refusalRate !== null ? t('analytics.refusedShort', { rate: percent(row.refusalRate) }) : undefined,
            }))}
          format={(value) => String(value)}
          empty={t('analytics.empty')}
        />
        {unknown ? (
          <p className="text-xs text-amber-800">
            {t('analytics.unknownAreaNote', { count: unknown.orders, total: totalOrders })}
          </p>
        ) : null}
      </Panel>
      <Panel title={t('analytics.table')}>
        <DataTable
          columns={groupColumns(t, locale, {
            key: 'key',
            label: t('analytics.col.governorate'),
            value: (row) => (row.key === '—' ? t('analytics.unknownArea') : row.key),
          })}
          rows={rows}
          rowKey={(row) => row.key}
          fileName={`governorates-${range.from}-${range.to}`}
        />
      </Panel>
    </div>
  );
}

function RefusalsReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  const now = summarize(data.lines, data.returns, data.orders, range);
  const before = summarize(data.lines, data.returns, data.orders, previousRange(range));
  const reasons = returnsByReason(data.returns, range);
  const lostToRefusals = sumMoney(reasons.filter((row) => row.type === 'failed_delivery').map((row) => row.value));
  // What Accurate charged for the parcels that came back, on the statements received in the range.
  const refusalFees = sumMoney(data.statementLines.filter((row) => row.outcome.startsWith('returned')).map((row) => Number(row.fee_egp)));
  const rateDelta = now.refusalRate === null || before.refusalRate === null ? null : now.refusalRate - before.refusalRate;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('analytics.kpi.refusalRate')}
          value={percent(now.refusalRate)}
          delta={rateDelta}
          deltaLabel={deltaText(rateDelta, t, true)}
          upIsGood={false}
        />
        <StatTile label={t('analytics.kpi.refused')} value={String(now.refused)} hint={t('analytics.ofFinished', { count: now.delivered + now.refused + now.returnedAfterDelivery })} />
        <StatTile label={t('analytics.kpi.salesLost')} value={wholeEGP(lostToRefusals, locale)} hint={t('analytics.salesLostHint')} />
        <StatTile label={t('analytics.kpi.refusalFees')} value={wholeEGP(refusalFees, locale)} hint={t('analytics.refusalFeesHint')} />
      </div>

      <Panel title={t('analytics.byReason')}>
        <DataTable
          columns={[
            {
              key: 'type',
              label: t('analytics.col.reason'),
              value: (row) => (row.reason ? t(`returnReason.${row.reason}`) : t(`analytics.returnType.${row.type}`)),
              render: (row) => (
                <span>
                  <span className="block font-semibold">
                    {row.reason ? t(`returnReason.${row.reason}`) : t(`analytics.returnType.${row.type}`)}
                  </span>
                  <span className="text-xs text-stone-500">{t(`analytics.returnType.${row.type}`)}</span>
                </span>
              ),
            },
            { key: 'orders', label: t('analytics.col.orders'), value: (row) => row.orders, numeric: true },
            { key: 'pieces', label: t('analytics.col.pieces'), value: (row) => row.pieces, numeric: true },
            { key: 'value', label: t('analytics.col.value'), value: (row) => row.value, render: (row) => formatEGP(row.value, locale), numeric: true },
          ]}
          rows={reasons}
          rowKey={(row) => row.key}
          fileName={`returns-by-reason-${range.from}-${range.to}`}
        />
      </Panel>

      {/* Who refuses: not to punish anyone - to decide who should pay up
          front, which is the one thing that stops a refusal costing anything. */}
      <Panel title={t('analytics.whoRefuses')} help={t('analytics.whoRefusesHelp')}>
        <DataTable
          columns={[
            {
              key: 'name',
              label: t('analytics.col.customer'),
              value: (row) => row.full_name,
              render: (row) => (
                <span>
                  <bdi className="block font-semibold">{row.full_name ?? '—'}</bdi>
                  <span className="tabular text-xs text-stone-500" dir="ltr">
                    {row.phone ?? ''}
                  </span>
                </span>
              ),
            },
            { key: 'orders', label: t('analytics.col.orders'), value: (row) => row.orders_placed, numeric: true },
            { key: 'refused', label: t('analytics.col.refused'), value: (row) => row.refusals, numeric: true },
            {
              key: 'rate',
              label: t('analytics.col.refusalRate'),
              value: (row) => Number(row.refusal_pct ?? 0),
              render: (row) => `${Math.round(Number(row.refusal_pct ?? 0))}%`,
              numeric: true,
            },
            {
              key: 'prepay',
              label: t('analytics.col.prepay'),
              value: (row) => (row.requires_prepayment ? t('analytics.yes') : ''),
            },
          ]}
          rows={data.reliability}
          rowKey={(row) => row.customer_id}
          fileName="customers-who-refuse"
          limit={20}
        />
      </Panel>
    </div>
  );
}

function CourierReport({ data }: { data: ReportData }) {
  const { t, locale } = useLocale();
  const value = sumMoney(data.custody.map((row) => Number(row.cod_amount_egp ?? 0)));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.kpi.parcels')} value={String(data.custody.length)} hint={t('analytics.rightNow')} />
        <StatTile label={t('analytics.kpi.pieces')} value={String(data.custody.reduce((n, row) => n + Number(row.units_out), 0))} />
        <StatTile label={t('analytics.kpi.withCourier')} value={wholeEGP(value, locale)} />
        <StatTile label={t('analytics.kpi.late')} value={String(data.overdue.size)} hint={t('analytics.lateHint')} />
      </div>
      <Panel title={t('analytics.report.courier.title')} help={t('analytics.courierHelp')}>
        <DataTable
          columns={[
            { key: 'order', label: t('analytics.col.order'), value: (row) => row.order_number, render: (row) => orderLink(row.order_number) },
            {
              key: 'tracking',
              label: t('analytics.col.tracking'),
              value: (row) => row.tracking_number,
              render: (row) => (
                <span className="tabular text-xs" dir="ltr">
                  {row.tracking_number ?? '—'}
                </span>
              ),
            },
            { key: 'customer', label: t('analytics.col.customer'), value: (row) => row.customer_name, render: (row) => <bdi>{row.customer_name ?? '—'}</bdi> },
            { key: 'area', label: t('analytics.col.governorate'), value: (row) => row.governorate, render: (row) => <bdi>{row.governorate ?? '—'}</bdi> },
            { key: 'status', label: t('analytics.col.status'), value: (row) => t(`fulfillment.${row.status}`) },
            { key: 'value', label: t('analytics.col.value'), value: (row) => Number(row.cod_amount_egp ?? 0), render: (row) => formatEGP(Number(row.cod_amount_egp ?? 0), locale), numeric: true },
            {
              key: 'days',
              label: t('analytics.col.days'),
              value: (row) => Math.floor(row.days_in_custody),
              render: (row) => (
                <span className={cx(data.overdue.has(row.shipment_id) && 'font-bold text-red-700')}>{Math.floor(row.days_in_custody)}</span>
              ),
              numeric: true,
            },
          ]}
          rows={data.custody}
          rowKey={(row) => row.shipment_id}
          fileName="with-the-courier"
        />
      </Panel>
    </div>
  );
}

function OwedReport({ data }: { data: ReportData }) {
  const { t, locale } = useLocale();
  const delivered = data.owed.filter((row) => row.fulfillment_status === 'delivered');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.kpi.owed')} value={wholeEGP(sumMoney(delivered.map((row) => Number(row.total_egp))), locale)} hint={t('analytics.ordersNow', { count: delivered.length })} />
        <StatTile
          label={t('analytics.kpi.oldest')}
          value={t('analytics.daysCount', { count: Math.floor(delivered[0]?.days_waiting ?? 0) })}
        />
        <StatTile label={t('analytics.kpi.returnsAwaiting')} value={String(data.owed.length - delivered.length)} hint={t('analytics.returnsAwaitingHint')} />
      </div>
      <Panel title={t('analytics.report.owed.title')} help={t('analytics.owedHelp')}>
        <DataTable
          columns={[
            { key: 'order', label: t('analytics.col.order'), value: (row) => row.order_number, render: (row) => orderLink(row.order_number) },
            { key: 'customer', label: t('analytics.col.customer'), value: (row) => row.customer_name, render: (row) => <bdi>{row.customer_name ?? '—'}</bdi> },
            { key: 'status', label: t('analytics.col.status'), value: (row) => t(`fulfillment.${row.fulfillment_status}`) },
            { key: 'value', label: t('analytics.col.goods'), value: (row) => Number(row.total_egp), render: (row) => formatEGP(Number(row.total_egp), locale), numeric: true },
            {
              key: 'days',
              label: t('analytics.col.days'),
              value: (row) => Math.floor(row.days_waiting),
              render: (row) => <span className={cx(row.days_waiting > 14 && 'font-bold text-red-700')}>{Math.floor(row.days_waiting)}</span>,
              numeric: true,
            },
          ]}
          rows={data.owed}
          rowKey={(row) => row.order_id}
          fileName="owed-by-the-courier"
        />
      </Panel>
    </div>
  );
}

function StatementsReport({ data }: { data: ReportData }) {
  const { t, locale } = useLocale();
  const received = sumMoney(data.statements.map((row) => Number(row.net_received_egp ?? row.net_egp)));
  const fees = sumMoney(data.statements.map((row) => Number(row.fees_egp)));
  const refusalFees = sumMoney(data.statementLines.filter((row) => row.outcome.startsWith('returned')).map((row) => Number(row.fee_egp)));
  const shipping = sumMoney(data.statementLines.map((row) => Number(row.shipping_gain_egp ?? 0)));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.kpi.received')} value={wholeEGP(received, locale)} hint={t('analytics.statementsCount', { count: data.statements.length })} />
        <StatTile label={t('analytics.kpi.courierFees')} value={wholeEGP(fees, locale)} />
        <StatTile label={t('analytics.kpi.refusalFees')} value={wholeEGP(refusalFees, locale)} />
        <StatTile label={t('analytics.kpi.shippingDifference')} value={wholeEGP(shipping, locale)} hint={t('analytics.shippingDifferenceHint')} />
      </div>
      <Panel title={t('analytics.report.statements.title')}>
        <DataTable
          columns={[
            {
              key: 'reference',
              label: t('analytics.col.statement'),
              value: (row) => row.reference,
              render: (row) => (
                <span className="tabular font-semibold" dir="ltr">
                  {row.reference ?? '—'}
                </span>
              ),
            },
            { key: 'date', label: t('analytics.col.date'), value: (row) => row.received_at, render: (row) => (row.received_at ? formatDate(row.received_at, locale) : '—') },
            { key: 'delivered', label: t('analytics.col.delivered'), value: (row) => row.delivered_count, numeric: true },
            { key: 'returns', label: t('analytics.col.refused'), value: (row) => row.return_count, numeric: true },
            { key: 'collected', label: t('analytics.col.collected'), value: (row) => Number(row.collected_egp), render: (row) => formatEGP(Number(row.collected_egp), locale), numeric: true },
            { key: 'fees', label: t('analytics.col.fees'), value: (row) => Number(row.fees_egp), render: (row) => formatEGP(-Number(row.fees_egp), locale), numeric: true },
            {
              key: 'received',
              label: t('analytics.col.received'),
              value: (row) => Number(row.net_received_egp ?? row.net_egp),
              render: (row) => <span className="font-semibold">{formatEGP(Number(row.net_received_egp ?? row.net_egp), locale)}</span>,
              numeric: true,
            },
          ]}
          rows={data.statements}
          rowKey={(row) => row.id}
          fileName="statements"
          empty={t('analytics.noStatements')}
        />
      </Panel>
    </div>
  );
}

function StockReport({ data }: { data: ReportData }) {
  const { t } = useLocale();
  const rows = useMemo(
    () => stockHealth(data.stock, data.lines, data.returns, cairoDate()),
    [data.stock, data.lines, data.returns],
  );
  const [state, setState] = useState<'all' | StockHealthRow['state']>('all');
  const count = (value: StockHealthRow['state']) => rows.filter((row) => row.state === value).length;
  const shown = state === 'all' ? rows : rows.filter((row) => row.state === state);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.stockState.out')} value={String(count('out'))} hint={t('analytics.stockHint.out')} />
        <StatTile label={t('analytics.stockState.low')} value={String(count('low'))} hint={t('analytics.stockHint.low')} />
        <StatTile label={t('analytics.stockState.slow')} value={String(count('slow'))} hint={t('analytics.stockHint.slow')} />
        <StatTile label={t('analytics.kpi.onHand')} value={String(rows.reduce((n, row) => n + Math.max(0, row.quantity), 0))} />
      </div>
      <Panel
        title={t('analytics.report.stock.title')}
        help={t('analytics.stockHelp')}
        action={
          <Segmented
            value={state}
            onChange={setState}
            options={(['all', 'out', 'low', 'slow', 'ok'] as const).map((value) => ({
              value,
              label: value === 'all' ? t('analytics.all') : t(`analytics.stockState.${value}`),
            }))}
          />
        }
      >
        <DataTable
          columns={[
            {
              key: 'product',
              label: t('analytics.col.product'),
              value: (row) => `${row.product_title} ${[row.size, row.color].filter(Boolean).join(' / ')}`,
              render: (row) => (
                <span className="block min-w-40">
                  <bdi className="block font-semibold">{row.product_title}</bdi>
                  <span className="flex flex-wrap gap-x-2 text-xs text-stone-500">
                    {row.size || row.color ? <bdi>{[row.size, row.color].filter(Boolean).join(' / ')}</bdi> : null}
                    <Link to={`/log?q=${encodeURIComponent(row.sku)}`} className="tabular underline decoration-stone-300 underline-offset-2" dir="ltr">
                      {row.sku}
                    </Link>
                  </span>
                </span>
              ),
            },
            { key: 'onHand', label: t('analytics.col.onHand'), value: (row) => row.quantity, numeric: true },
            { key: 'sold', label: t('analytics.col.sold30'), value: (row) => row.sold, numeric: true },
            {
              key: 'cover',
              label: t('analytics.col.cover'),
              value: (row) => row.cover ?? Number.POSITIVE_INFINITY,
              render: (row) => (row.cover === null ? '—' : t('analytics.daysCount', { count: row.cover })),
              numeric: true,
            },
            {
              key: 'state',
              label: t('analytics.col.state'),
              value: (row) => t(`analytics.stockState.${row.state}`),
              render: (row) => <StockBadge state={row.state} />,
            },
          ]}
          rows={shown}
          rowKey={(row) => row.variant_id}
          fileName={`stock-health-${state}`}
          limit={60}
        />
      </Panel>
    </div>
  );
}

function StockBadge({ state }: { state: StockHealthRow['state'] }) {
  const { t } = useLocale();
  return (
    <span
      className={cx(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold',
        state === 'out' && 'bg-red-50 text-red-700',
        state === 'low' && 'bg-amber-50 text-amber-800',
        state === 'slow' && 'bg-stone-100 text-stone-600',
        state === 'ok' && 'bg-emerald-50 text-emerald-700',
      )}
    >
      {t(`analytics.stockState.${state}`)}
    </span>
  );
}

function TakenOutReport({ data }: { data: ReportData }) {
  const { t, locale } = useLocale();
  const open = data.takenOut.filter((row) => row.outstanding > 0 && !['returned', 'kept', 'gone'].includes(row.status));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.kpi.piecesOut')} value={String(open.reduce((n, row) => n + Number(row.outstanding), 0))} hint={t('analytics.rightNow')} />
        <StatTile label={t('analytics.kpi.overdue')} value={String(open.filter((row) => row.status === 'overdue').length)} />
      </div>
      <Panel title={t('analytics.report.takenOut.title')} help={t('analytics.takenOutHelp')}>
        <DataTable
          columns={[
            { key: 'who', label: t('analytics.col.who'), value: (row) => row.taken_by, render: (row) => <bdi className="font-semibold">{row.taken_by ?? '—'}</bdi> },
            {
              key: 'why',
              label: t('analytics.col.why'),
              value: (row) => (row.reason === 'other' ? row.reason_text : t(`stockOut.reason.${row.reason}`)),
              render: (row) => (
                <span>
                  <span className="block">{row.reason === 'other' ? row.reason_text : t(`stockOut.reason.${row.reason}`)}</span>
                  {row.note ? <bdi className="text-xs text-stone-500">{row.note}</bdi> : null}
                </span>
              ),
            },
            { key: 'out', label: t('analytics.col.stillOut'), value: (row) => row.outstanding, numeric: true },
            { key: 'since', label: t('analytics.col.since'), value: (row) => row.created_at, render: (row) => formatDate(row.created_at, locale) },
            {
              key: 'back',
              label: t('analytics.col.backBy'),
              value: (row) => row.return_by,
              render: (row) =>
                row.return_by ? (
                  <span className={cx(row.status === 'overdue' && 'font-bold text-red-700')}>{formatDate(row.return_by, locale)}</span>
                ) : (
                  '—'
                ),
            },
          ]}
          rows={open}
          rowKey={(row) => row.id}
          fileName="pieces-taken-out"
          empty={t('analytics.nothingOut')}
        />
      </Panel>
    </div>
  );
}

function CustomersReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  const now = customers(data.orders, range);
  const before = customers(data.orders, previousRange(range));
  const shareReturning = now.newCustomers + now.returningCustomers > 0 ? now.returningCustomers / (now.newCustomers + now.returningCustomers) : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('analytics.kpi.newCustomers')}
          value={String(now.newCustomers)}
          delta={change(now.newCustomers, before.newCustomers)}
          deltaLabel={deltaText(change(now.newCustomers, before.newCustomers), t)}
        />
        <StatTile
          label={t('analytics.kpi.returningCustomers')}
          value={String(now.returningCustomers)}
          delta={change(now.returningCustomers, before.returningCustomers)}
          deltaLabel={deltaText(change(now.returningCustomers, before.returningCustomers), t)}
        />
        <StatTile label={t('analytics.kpi.returningShare')} value={percent(shareReturning)} hint={t('analytics.sinceCrm')} />
        <StatTile label={t('analytics.kpi.returningValue')} value={wholeEGP(now.returningValue, locale)} />
      </div>
      <Panel title={t('analytics.topCustomers')}>
        <DataTable
          columns={[
            {
              key: 'name',
              label: t('analytics.col.customer'),
              value: (row) => row.name,
              render: (row) => (
                <span>
                  <bdi className="block font-semibold">{row.name ?? '—'}</bdi>
                  <span className="tabular text-xs text-stone-500" dir="ltr">
                    {row.phone ?? ''}
                  </span>
                </span>
              ),
            },
            { key: 'orders', label: t('analytics.col.orders'), value: (row) => row.orders, numeric: true },
            { key: 'value', label: t('analytics.col.ordered'), value: (row) => row.value, render: (row) => formatEGP(row.value, locale), numeric: true },
          ]}
          rows={now.top}
          rowKey={(row) => row.key}
          fileName={`customers-${range.from}-${range.to}`}
          limit={25}
        />
      </Panel>
    </div>
  );
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

function ValuationReport() {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<ValuationRow[] | null>(null);
  useEffect(() => {
    supabase
      .from('v_stock_valuation')
      .select('*')
      .order('stock_value_egp', { ascending: false })
      .limit(1000)
      .then(({ data }) => setRows((data ?? []) as ValuationRow[]));
  }, []);
  if (!rows) return null;
  const costed = rows.filter((row) => Number(row.cost_egp) > 0);
  return (
    <div className="space-y-4">
      {costed.length === 0 ? (
        <Card className="border-amber-200 bg-amber-50 text-sm text-amber-900">{t('analytics.noCosts')}</Card>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.kpi.stockValue')} value={wholeEGP(sumMoney(rows.map((row) => Number(row.stock_value_egp))), locale)} />
        <StatTile label={t('analytics.kpi.costed')} value={`${costed.length} / ${rows.length}`} />
      </div>
      <Panel title={t('analytics.report.valuation.title')}>
        <DataTable
          columns={[
            {
              key: 'product',
              label: t('analytics.col.product'),
              value: (row) => row.product_title,
              render: (row) => (
                <span>
                  <bdi className="block font-semibold">{row.product_title}</bdi>
                  <span className="tabular text-xs text-stone-500" dir="ltr">
                    {row.sku}
                  </span>
                </span>
              ),
            },
            { key: 'qty', label: t('analytics.col.onHand'), value: (row) => row.quantity, numeric: true },
            { key: 'cost', label: t('analytics.col.cost'), value: (row) => Number(row.cost_egp), render: (row) => formatEGP(Number(row.cost_egp), locale), numeric: true },
            { key: 'value', label: t('analytics.col.value'), value: (row) => Number(row.stock_value_egp), render: (row) => formatEGP(Number(row.stock_value_egp), locale), numeric: true },
          ]}
          rows={rows}
          rowKey={(row) => `${row.variant_id}:${row.location_name}`}
          fileName="stock-value"
          limit={50}
        />
      </Panel>
    </div>
  );
}

