import { formatDate, formatEGP } from '@duch/shared';
import type { CourierMoneyRow, DayPoint, GroupRow, ItemRow, MoneyInRow } from '../../lib/reportMath';
import { cx } from '../../components/ui';
import { percent, type Column } from './parts';

/**
 * The columns the reports share, so a report put together by hand shows the
 * very same tables as the report each part comes from.
 */

export type T = (key: string, params?: Record<string, unknown>) => string;

/** Sales by day, week or month: orders, pieces, and how gross becomes net. */
export function dayColumns(t: T, locale: 'ar' | 'en', grain: 'day' | 'week' | 'month'): Column<DayPoint>[] {
  const money = (value: number) => formatEGP(value, locale);
  // Shown as money taken off, without a "-0.00" where nothing was.
  const less = (value: number) => (value === 0 ? money(0) : money(-value));
  return [
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
}

/** What sold, by product, variant, size or colour: pieces, what came back, and net sales. */
export function itemColumns(t: T, locale: 'ar' | 'en', view: 'product' | 'variant' | 'size' | 'color'): Column<ItemRow>[] {
  return [
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
}

/** Orders by where they came from: how many, their value, and how they ended. */
export function groupColumns(t: T, locale: 'ar' | 'en', first: Column<GroupRow>): Column<GroupRow>[] {
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

export function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3', strong && 'font-extrabold')}>
      <dt className={strong ? '' : 'text-stone-500'}>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

/** Each transfer or payment that came in, and each refund paid back. */
export function moneyInColumns(t: T, locale: 'ar' | 'en'): Column<MoneyInRow>[] {
  return [
    {
      key: 'day',
      label: t('analytics.col.date'),
      value: (row) => row.received_on,
      render: (row) => <span className="tabular">{formatDate(row.received_on, locale)}</span>,
    },
    { key: 'source', label: t('analytics.custom.money.source'), value: (row) => t(`analytics.custom.money.from.${row.source}`) },
    {
      key: 'ref',
      label: t('analytics.custom.money.ref'),
      value: (row) => row.label,
      render: (row) => (
        <span className="tabular" dir="ltr">
          {row.label ?? '—'}
        </span>
      ),
    },
    {
      key: 'amount',
      label: t('analytics.col.value'),
      value: (row) => Number(row.amount_egp),
      render: (row) => <span className={cx('font-semibold', Number(row.amount_egp) < 0 && 'text-red-700')}>{formatEGP(Number(row.amount_egp), locale)}</span>,
      numeric: true,
    },
  ];
}

/** Each parcel whose cash a courier or our driver holds, or is out to collect. */
export function courierMoneyColumns(t: T, locale: 'ar' | 'en'): Column<CourierMoneyRow>[] {
  // Our driver by name; a courier company by its name.
  const holder = (row: CourierMoneyRow) =>
    row.courier === 'own' ? (row.driver_name ?? t('orders.courier.own')) : t(`orders.courier.${row.courier}`);
  return [
    {
      key: 'order',
      label: t('analytics.col.order'),
      value: (row) => row.order_number,
      render: (row) => (
        <span className="tabular font-semibold" dir="ltr">
          {row.order_number}
        </span>
      ),
    },
    { key: 'customer', label: t('analytics.col.customer'), value: (row) => row.customer_name, render: (row) => <bdi>{row.customer_name ?? '—'}</bdi> },
    {
      key: 'with',
      label: t('analytics.custom.money.with'),
      value: (row) => holder(row),
      render: (row) => <bdi>{holder(row)}</bdi>,
    },
    { key: 'state', label: t('analytics.col.status'), value: (row) => t(`analytics.custom.money.state.${row.state}`) },
    { key: 'days', label: t('analytics.col.days'), value: (row) => Math.floor(Number(row.days)), numeric: true },
    {
      key: 'amount',
      label: t('analytics.col.value'),
      value: (row) => Number(row.amount_egp),
      render: (row) => formatEGP(Number(row.amount_egp), locale),
      numeric: true,
    },
  ];
}
