import { formatDate, formatEGP } from '@duch/shared';
import type { DayPoint, GroupRow, ItemRow } from '../../lib/reportMath';
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
