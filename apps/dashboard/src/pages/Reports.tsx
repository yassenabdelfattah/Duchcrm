import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useGetIdentity } from '@refinedev/core';
import { ArrowRight } from 'lucide-react';
import { cairoDate, can, formatDate } from '@duch/shared';
import { addDays, previousRange, type Range } from '../lib/reportMath';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import { Card, ErrorNote, Input, Spinner, cx } from '../components/ui';
import { useReportData } from './reports/useReportData';
import { REPORT_GROUPS, ReportView, ReportsHome, type ReportKey } from './reports/views';

/**
 * Reports, the way Shopify lays them out: a date range at the top that
 * scopes everything, the headline numbers against the period before, sales
 * over time, and a list of reports that each open into a chart and a table.
 *
 * Sales are net - what was ordered, less discounts, less what came back on
 * the day it came back - and never a cancelled order (the owner, 2026-10-28).
 * The log of every movement, which used to be a tab here, is its own page.
 */

type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'thisMonth' | 'lastMonth';

function presetRange(preset: Preset): Range {
  const today = cairoDate();
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'last30':
      return { from: addDays(today, -29), to: today };
    case 'last90':
      return { from: addDays(today, -89), to: today };
    case 'thisMonth':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastMonth': {
      const end = addDays(`${today.slice(0, 7)}-01`, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
  }
}

const PRESETS: Preset[] = ['today', 'yesterday', 'last7', 'last30', 'last90', 'thisMonth', 'lastMonth'];
const ALL_REPORTS: readonly string[] = REPORT_GROUPS.flatMap((group) => group.reports);

export function Reports() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  // Cost is the margin, so stock value is for whoever may see costs.
  const mayViewValuation = can(identity?.permissions, 'products.manage');

  const [params, setParams] = useSearchParams();
  const requested = params.get('r');
  const report = requested && ALL_REPORTS.includes(requested) ? (requested as ReportKey) : null;

  const [preset, setPreset] = useState<Preset | 'custom'>('last30');
  const [range, setRange] = useState<Range>(() => presetRange('last30'));
  const { data, loading, error } = useReportData(range);
  const previous = useMemo(() => previousRange(range), [range]);

  function choose(value: Preset) {
    setPreset(value);
    setRange(presetRange(value));
  }

  function open(key: ReportKey | null) {
    setParams(key ? { r: key } : {});
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {report ? (
          <button
            type="button"
            onClick={() => open(null)}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-stone-600 hover:bg-stone-100"
          >
            <ArrowRight className="h-4 w-4 ltr:rotate-180" aria-hidden />
            {t('analytics.title')}
          </button>
        ) : null}
        <h1 className="text-lg font-extrabold">
          {report ? t(`analytics.report.${report}.title`) : t('analytics.title')}
        </h1>
      </div>

      {/* One range for everything on the page, the common ones a tap away. */}
      <Card className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => choose(value)}
              className={cx(
                'min-h-9 rounded-full px-3 text-xs font-semibold transition-colors',
                preset === value ? 'bg-duch-ink text-white' : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
              )}
            >
              {t(`analytics.preset.${value}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-stone-500">{t('analytics.from')}</span>
            <Input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(event) => {
                if (!event.target.value) return;
                setPreset('custom');
                setRange((current) => ({ ...current, from: event.target.value }));
              }}
              className="tabular"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-bold text-stone-500">{t('analytics.to')}</span>
            <Input
              type="date"
              value={range.to}
              min={range.from}
              max={cairoDate()}
              onChange={(event) => {
                if (!event.target.value) return;
                setPreset('custom');
                setRange((current) => ({ ...current, to: event.target.value }));
              }}
              className="tabular"
            />
          </label>
          <p className="pb-2 text-xs text-stone-500">
            {t('analytics.comparedWith', {
              from: formatDate(previous.from, locale),
              to: formatDate(previous.to, locale),
            })}
          </p>
        </div>
      </Card>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!data ? (
        <Spinner label={t('app.loading')} />
      ) : (
        // A new range keeps the page as it was, faded, until the numbers arrive.
        <div className={cx('transition-opacity', loading && 'pointer-events-none opacity-50')}>
          {report ? (
            // Keyed, so "sizes" opened straight after "products" starts on its own view.
            <ReportView key={report} report={report} data={data} range={range} />
          ) : (
            <ReportsHome data={data} range={range} mayViewValuation={mayViewValuation} onOpen={open} />
          )}
        </div>
      )}
    </div>
  );
}
