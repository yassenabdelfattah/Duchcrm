import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { toCsv } from '../../lib/reportMath';
import { useLocale } from '../../i18n';
import { Sparkline } from '../../components/charts';
import { Button, Card, cx } from '../../components/ui';

/** Whole pounds: a headline does not need the piastres. */
export function wholeEGP(value: number, locale: 'ar' | 'en'): string {
  return new Intl.NumberFormat(`${locale === 'ar' ? 'ar-EG' : 'en-EG'}-u-nu-latn`, {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  })
    .format(value)
    .replace(/[‎‏]/g, '');
}

export const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

/**
 * A headline number, how it moved since the period before, and the shape of
 * the period. Up is not always good: a rising refusal rate is marked as bad.
 */
export function StatTile({
  label,
  value,
  delta,
  deltaLabel,
  upIsGood = true,
  trend,
  hint,
}: {
  label: string;
  value: string;
  /** A fraction (0.12 for 12%), or points for a rate; null or undefined shows no change. */
  delta?: number | null;
  deltaLabel?: string;
  upIsGood?: boolean;
  trend?: number[];
  hint?: string;
}) {
  const direction = delta === undefined || delta === null || Math.abs(delta) < 0.005 ? 0 : delta > 0 ? 1 : -1;
  const good = direction === 0 ? null : (direction > 0) === upIsGood;
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-xs font-bold text-stone-500">{label}</p>
      <p className="text-xl font-extrabold leading-tight">{value}</p>
      {delta !== undefined ? (
        <p
          className={cx(
            'inline-flex items-center gap-1 text-xs font-semibold',
            good === null ? 'text-stone-500' : good ? 'text-emerald-700' : 'text-red-700',
          )}
        >
          {direction > 0 ? <ArrowUp className="h-3.5 w-3.5" aria-hidden /> : direction < 0 ? <ArrowDown className="h-3.5 w-3.5" aria-hidden /> : null}
          <span className="tabular">{deltaLabel}</span>
        </p>
      ) : hint ? (
        <p className="text-xs text-stone-500">{hint}</p>
      ) : null}
      {trend ? <div className="mt-auto pt-1"><Sparkline values={trend} /></div> : null}
    </Card>
  );
}

export function Panel({
  title,
  help,
  action,
  children,
  className,
}: {
  title: string;
  help?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cx('space-y-3', className)}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">{title}</h2>
          {help ? <p className="mt-0.5 text-xs text-stone-500">{help}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  /** What it sorts and downloads by. */
  value: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  numeric?: boolean;
}

/**
 * Every report's numbers as a table: sortable by any column, downloadable as
 * a spreadsheet, and the place every chart's values can be read without
 * hovering.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  fileName,
  totals,
  empty,
  limit,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  fileName: string;
  totals?: Record<string, ReactNode>;
  empty?: string;
  /** Show this many until asked for the rest. */
  limit?: number;
}) {
  const { t } = useLocale();
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [all, setAll] = useState(false);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return rows;
    return [...rows].sort((a, b) => {
      const x = column.value(a);
      const y = column.value(b);
      const order =
        typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'ar');
      return sort.desc ? -order : order;
    });
  }, [columns, rows, sort]);

  const shown = limit && !all ? sorted.slice(0, limit) : sorted;

  function download() {
    const csv = toCsv(
      columns.map((column) => column.label),
      sorted.map((row) => columns.map((column) => column.value(row))),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (rows.length === 0) return <p className="text-sm text-stone-500">{empty ?? t('analytics.empty')}</p>;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-duch-line text-xs text-stone-500">
              {columns.map((column) => (
                <th key={column.key} className={cx('py-2 font-bold', column.numeric ? 'text-end' : 'text-start')}>
                  <button
                    type="button"
                    onClick={() =>
                      setSort((current) =>
                        current?.key === column.key ? { key: column.key, desc: !current.desc } : { key: column.key, desc: Boolean(column.numeric) },
                      )
                    }
                    className="inline-flex items-center gap-1 whitespace-nowrap hover:text-duch-ink"
                  >
                    {column.label}
                    {sort?.key === column.key ? (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={rowKey(row)} className="border-b border-stone-100">
                {columns.map((column) => (
                  <td key={column.key} className={cx('py-2 pe-3 last:pe-0', column.numeric ? 'tabular text-end' : '')}>
                    {column.render ? column.render(row) : column.value(row) ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className="font-bold">
                {columns.map((column, index) => (
                  <td key={column.key} className={cx('py-2 pe-3 last:pe-0', column.numeric ? 'tabular text-end' : '')}>
                    {index === 0 ? (totals[column.key] ?? t('analytics.total')) : (totals[column.key] ?? '')}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {limit && rows.length > limit ? (
          <Button variant="ghost" className="min-h-9 text-xs" onClick={() => setAll((open) => !open)}>
            {all ? t('analytics.showLess') : t('analytics.showAll', { count: rows.length })}
          </Button>
        ) : null}
        <Button variant="ghost" className="ms-auto min-h-9 text-xs" onClick={download}>
          <Download className="h-3.5 w-3.5" aria-hidden />
          {t('analytics.download')}
        </Button>
      </div>
    </div>
  );
}

/** A row of choices, one selected. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            'min-h-9 rounded-full px-3 text-xs font-semibold transition-colors',
            value === option.value ? 'bg-duch-ink text-white' : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
