import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Sparkline } from '../../components/charts';
import { Card, cx } from '../../components/ui';

// The table and the segmented row grew up here and now live with the other
// shared components, for every screen; the reports keep importing them from
// this file as before.
export { DataTable, Segmented, type Column } from '../../components/table';

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
