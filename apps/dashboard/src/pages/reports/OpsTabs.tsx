import { useMemo } from 'react';
import { Link } from 'react-router';
import { formatDate, formatEGP, sumMoney } from '@duch/shared';
import {
  moneyIn,
  moneyWithCouriers,
  returnsByReason,
  summarize,
  within,
  type MoneyInRow,
  type Range,
  type ReturnLine,
  type SaleLine,
} from '../../lib/reportMath';
import { useLocale } from '../../i18n';
import { ErrorNote, ListSkeleton, cx } from '../../components/ui';
import { DataTable, Panel, StatTile, percent, wholeEGP, type Column } from './parts';
import { courierMoneyColumns, moneyInColumns, type T } from './columns';
import { useCustody, useMoneyIn, useReliability, type SalesRows } from './data';

/**
 * The day-to-day lists: what came back, what was refused, what the courier
 * holds, and the money that came in. Each is a few figures and one list -
 * every figure the sum of the rows under it.
 */

const orderLink = (orderNumber: string) => (
  <Link to={`/orders?q=${encodeURIComponent(orderNumber)}`} className="tabular font-semibold underline decoration-stone-300 underline-offset-2" dir="ltr">
    {orderNumber}
  </Link>
);

/** One parcel that came back: its pieces together, against what the order had. */
interface BackRow {
  key: string;
  order_id: string;
  order_number: string;
  returned_on: string;
  type: string;
  reason: string | null;
  governorate: string | null;
  items: string;
  pieces: number;
  /** Pieces on the order as it was placed. */
  ordered: number;
  value: number;
}

function groupBack(lines: ReturnLine[], ordered: SaleLine[], range: Range): BackRow[] {
  const orderPieces = new Map<string, number>();
  for (const line of ordered) orderPieces.set(line.order_id, (orderPieces.get(line.order_id) ?? 0) + line.quantity);

  const rows = new Map<string, BackRow & { names: Map<string, number> }>();
  for (const line of lines) {
    if (!within(line.returned_on, range)) continue;
    const key = line.return_id ?? `${line.order_id}|${line.returned_on}|${line.return_type}`;
    const row = rows.get(key) ?? {
      key,
      order_id: line.order_id,
      order_number: line.order_number,
      returned_on: line.returned_on,
      type: line.return_type,
      reason: line.reason,
      governorate: line.governorate,
      items: '',
      pieces: 0,
      ordered: orderPieces.get(line.order_id) ?? 0,
      value: 0,
      names: new Map<string, number>(),
    };
    row.pieces += line.quantity;
    row.value += Number(line.value_egp);
    const name = [line.product_title, line.size, line.color].filter(Boolean).join(' ');
    row.names.set(name, (row.names.get(name) ?? 0) + line.quantity);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ names, ...row }) => ({
      ...row,
      value: sumMoney([row.value]),
      items: [...names.entries()].map(([name, count]) => (count > 1 ? `${count} × ${name}` : name)).join('، '),
    }))
    .sort((a, b) => b.returned_on.localeCompare(a.returned_on) || a.order_number.localeCompare(b.order_number));
}

function backColumns(t: T, locale: 'ar' | 'en', kind: 'returns' | 'refusals'): Column<BackRow>[] {
  return [
    { key: 'day', label: t('analytics.col.date'), value: (row) => row.returned_on, render: (row) => <span className="tabular">{formatDate(row.returned_on, locale)}</span> },
    { key: 'order', label: t('analytics.col.order'), value: (row) => row.order_number, render: (row) => orderLink(row.order_number) },
    {
      key: 'reason',
      label: t('analytics.col.reason'),
      value: (row) => (row.reason ? t(`returnReason.${row.reason}`) : t(`analytics.returnType.${row.type}`)),
      render: (row) => (
        <span>
          <span className="block">{row.reason ? t(`returnReason.${row.reason}`) : t(`analytics.returnType.${row.type}`)}</span>
          {kind === 'returns' ? <span className="text-xs text-stone-500">{t(`analytics.returnType.${row.type}`)}</span> : null}
        </span>
      ),
    },
    { key: 'items', label: t('ops.col.items'), value: (row) => row.items, render: (row) => <bdi className="block min-w-40 text-xs">{row.items}</bdi> },
    {
      key: 'pieces',
      label: t('ops.col.back'),
      value: (row) => row.pieces,
      // "1 of 2": the customer kept the other one.
      render: (row) =>
        row.ordered > row.pieces ? (
          <span className="whitespace-nowrap">
            {t('ops.partOf', { count: row.pieces, total: row.ordered })}
            <span className="ms-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-800">{t('ops.partial')}</span>
          </span>
        ) : (
          row.pieces
        ),
      numeric: true,
    },
    { key: 'value', label: t('analytics.col.value'), value: (row) => row.value, render: (row) => formatEGP(row.value, locale), numeric: true },
  ];
}

// --- Returns after delivery ----------------------------------------------------------------------

export function ReturnsTab({ rows, range }: { rows: SalesRows; range: Range }) {
  const { t, locale } = useLocale();
  // Refusals at the door are their own list; here is what came back after delivery.
  const list = useMemo(() => groupBack(rows.returns, rows.ordered, range), [rows, range]);
  const exchanges = list.filter((row) => row.type === 'exchange');
  const plain = list.filter((row) => row.type !== 'exchange');
  const pieces = list.reduce((total, row) => total + row.pieces, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('ops.returns.count')} value={String(plain.length)} hint={t('ops.returns.countHint')} />
        <StatTile label={t('ops.returns.exchanges')} value={String(exchanges.length)} hint={t('ops.returns.exchangesHint')} />
        <StatTile label={t('ops.returns.pieces')} value={String(pieces)} />
        <StatTile label={t('ops.returns.value')} value={wholeEGP(sumMoney(list.map((row) => row.value)), locale)} hint={t('ops.returns.valueHint')} />
      </div>
      <Panel title={t('ops.returns.title')} help={t('ops.returns.help')}>
        <DataTable
          columns={backColumns(t, locale, 'returns')}
          rows={list}
          rowKey={(row) => row.key}
          fileName={`returns-${range.from}-${range.to}`}
          empty={t('ops.returns.none')}
          totals={{ pieces, value: formatEGP(sumMoney(list.map((row) => row.value)), locale) }}
        />
      </Panel>
    </div>
  );
}

// --- Refusals at the door --------------------------------------------------------------------------

export function RefusalsTab({ rows, range }: { rows: SalesRows; range: Range }) {
  const { t, locale } = useLocale();
  const reliability = useReliability(true);
  const list = useMemo(() => groupBack(rows.refusals, rows.ordered, range), [rows, range]);
  const now = useMemo(() => summarize(rows.lines, rows.returns, rows.orders, range), [rows, range]);
  const reasons = useMemo(() => returnsByReason(rows.refusals, range), [rows, range]);
  const whole = list.filter((row) => row.ordered <= row.pieces);
  const partial = list.filter((row) => row.ordered > row.pieces);
  const value = sumMoney(list.map((row) => row.value));
  const pieces = list.reduce((total, row) => total + row.pieces, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('ops.refusals.rate')} value={percent(now.refusalRate)} hint={t('ops.refusals.rateHint', { count: now.delivered + now.refused + now.returnedAfterDelivery })} />
        <StatTile label={t('ops.refusals.whole')} value={String(whole.length)} hint={t('ops.refusals.wholeHint')} />
        <StatTile label={t('ops.refusals.partial')} value={String(partial.length)} hint={t('ops.refusals.partialHint')} />
        <StatTile label={t('ops.refusals.value')} value={wholeEGP(value, locale)} hint={t('ops.refusals.valueHint')} />
      </div>

      <Panel title={t('ops.refusals.title')} help={t('ops.refusals.help')}>
        <DataTable
          columns={backColumns(t, locale, 'refusals')}
          rows={list}
          rowKey={(row) => row.key}
          fileName={`refusals-${range.from}-${range.to}`}
          empty={t('ops.refusals.none')}
          totals={{ pieces, value: formatEGP(value, locale) }}
          limit={15}
        />
      </Panel>

      <Panel title={t('analytics.byReason')}>
        <DataTable
          columns={[
            { key: 'reason', label: t('analytics.col.reason'), value: (row) => (row.reason ? t(`returnReason.${row.reason}`) : t(`analytics.returnType.${row.type}`)) },
            { key: 'orders', label: t('analytics.col.orders'), value: (row) => row.orders, numeric: true },
            { key: 'pieces', label: t('analytics.col.pieces'), value: (row) => row.pieces, numeric: true },
            { key: 'value', label: t('analytics.col.value'), value: (row) => row.value, render: (row) => formatEGP(row.value, locale), numeric: true },
          ]}
          rows={reasons}
          rowKey={(row) => row.key}
          fileName={`refusal-reasons-${range.from}-${range.to}`}
          empty={t('ops.refusals.none')}
        />
      </Panel>

      <Panel title={t('analytics.whoRefuses')} help={t('analytics.whoRefusesHelp')}>
        {reliability.error ? <ErrorNote>{reliability.error}</ErrorNote> : null}
        <DataTable
          columns={[
            {
              key: 'customer',
              label: t('analytics.col.customer'),
              value: (row) => row.full_name,
              render: (row) => (
                <span className="block">
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
            { key: 'tookAfter', label: t('analytics.col.tookAfter'), value: (row) => Number(row.received_since_refusal ?? 0), numeric: true },
            { key: 'prepay', label: t('analytics.col.prepay'), value: (row) => (row.requires_prepayment ? t('analytics.yes') : '') },
          ]}
          rows={reliability.data ?? []}
          rowKey={(row) => row.customer_id}
          fileName="customers-who-refuse"
          limit={15}
        />
      </Panel>
    </div>
  );
}

// --- With the courier ---------------------------------------------------------------------------------

export function CourierTab() {
  const { t, locale } = useLocale();
  const { data, error } = useCustody(true);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <ListSkeleton label={t('app.loading')} />;
  const held = moneyWithCouriers(data.withCouriers);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('ops.courier.total')} value={wholeEGP(held.total, locale)} hint={t('analytics.rightNow')} />
        <StatTile label={t('ops.courier.collected')} value={wholeEGP(held.collected.amount, locale)} hint={t('analytics.ordersNow', { count: held.collected.count })} />
        <StatTile label={t('ops.courier.out')} value={wholeEGP(held.out.amount + held.ownOut.amount, locale)} hint={t('analytics.ordersNow', { count: held.out.count + held.ownOut.count })} />
        <StatTile label={t('analytics.kpi.late')} value={String(data.overdue.size)} hint={t('analytics.lateHint')} />
      </div>

      <Panel title={t('ops.courier.moneyTitle')} help={t('ops.courier.moneyHelp')}>
        <DataTable
          columns={courierMoneyColumns(t, locale)}
          rows={data.withCouriers}
          rowKey={(row) => row.shipment_id}
          fileName="money-with-couriers"
          empty={t('ops.courier.none')}
          totals={{ amount: formatEGP(held.total, locale) }}
          limit={15}
        />
      </Panel>

      <Panel title={t('ops.courier.parcelsTitle')} help={t('analytics.courierHelp')}>
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
            { key: 'pieces', label: t('analytics.col.pieces'), value: (row) => Number(row.units_out), numeric: true },
            {
              key: 'days',
              label: t('analytics.col.days'),
              value: (row) => Math.floor(row.days_in_custody),
              render: (row) => <span className={cx(data.overdue.has(row.shipment_id) && 'font-bold text-red-700')}>{Math.floor(row.days_in_custody)}</span>,
              numeric: true,
            },
          ]}
          rows={data.custody}
          rowKey={(row) => row.shipment_id}
          fileName="with-the-courier"
          empty={t('ops.courier.none')}
          limit={15}
        />
      </Panel>
    </div>
  );
}

// --- Money that came in ---------------------------------------------------------------------------------

export function MoneyTab({ range }: { range: Range }) {
  const { t, locale } = useLocale();
  const { data, error } = useMoneyIn(range, true);
  const cash = useMemo(() => moneyIn((data ?? []) as MoneyInRow[], range), [data, range]);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <ListSkeleton label={t('app.loading')} />;

  return (
    <div className="space-y-4">
      <Panel title={t('ops.money.title')} help={t('ops.money.help')}>
        <dl className="space-y-2 text-sm">
          {cash.bySource.map((row) => (
            <div key={row.source} className="flex items-baseline justify-between gap-3">
              <dt className="text-stone-600">
                {t(`analytics.custom.money.from.${row.source}`)} <span className="text-xs text-stone-400">({row.count})</span>
              </dt>
              <dd className={cx('tabular font-semibold', row.amount < 0 && 'text-red-700')}>
                {formatEGP(row.amount, locale)}
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3 border-t border-duch-line pt-2 font-extrabold">
            <dt>{t('ops.money.total')}</dt>
            <dd className="tabular">
              {formatEGP(cash.total, locale)}
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel title={t('ops.money.listTitle')}>
        <DataTable
          columns={moneyInColumns(t, locale)}
          rows={cash.rows}
          rowKey={(row) => `${row.source}-${row.ref_id}-${row.received_on}-${row.amount_egp}`}
          fileName={`money-in-${range.from}-${range.to}`}
          empty={t('ops.money.none')}
          totals={{ amount: formatEGP(cash.total, locale) }}
          limit={20}
        />
      </Panel>
    </div>
  );
}
