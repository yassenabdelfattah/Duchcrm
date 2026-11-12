import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useGetIdentity } from '@refinedev/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cairoDate, can, formatDate } from '@duch/shared';
import type { Range } from '../lib/reportMath';
import { addMonths, monthRange } from '../lib/profitMath';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import { Button, Card, ErrorNote, Input, ListSkeleton, cx } from '../components/ui';
import { useSalesRows } from './reports/data';
import { useProfitModel } from './reports/model';
import { ProfitTab } from './reports/ProfitTab';
import { MonthlyReport } from './reports/MonthlyReport';
import { CostsTab, type CostsView } from './reports/CostsTab';
import { CourierTab, MoneyTab, RefusalsTab, ReturnsTab } from './reports/OpsTabs';

/**
 * Reports, rebuilt around one question (the owner, 2026-11-11): what did we
 * actually make?
 *
 * A month is picked at the top. Profit shows the statement for it - sales
 * that are delivered and paid for, less what the pieces cost, the ads, what
 * the courier cost and the fixed costs - with every line opening to what is
 * behind it. The monthly report is the same on one page, to print or
 * download. Costs is where the figures are typed in. Those three need the
 * profit.view permission; without it the page is the four day-to-day lists.
 */

const PROFIT_TABS = ['profit', 'monthly', 'costs'] as const;
const OPS_TABS = ['returns', 'refusals', 'courier', 'money'] as const;
type Tab = (typeof PROFIT_TABS)[number] | (typeof OPS_TABS)[number];
const COSTS_VIEWS: readonly CostsView[] = ['products', 'runs', 'ads', 'expenses', 'gift'];

/** "نوفمبر 2026", in Latin digits like every other number here. */
function monthName(month: string, locale: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(`${locale === 'ar' ? 'ar-EG' : 'en-GB'}-u-nu-latn`, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`))
    .replace(/[‎‏]/g, '');
}

export function Reports() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayProfit = can(identity?.permissions, 'profit.view');
  const tabs: readonly Tab[] = mayProfit ? [...PROFIT_TABS, ...OPS_TABS] : OPS_TABS;

  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked && tabs.includes(asked) ? asked : tabs[0]!;
  const askedView = params.get('view') as CostsView | null;
  const view: CostsView = askedView && COSTS_VIEWS.includes(askedView) ? askedView : 'products';

  const today = cairoDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [custom, setCustom] = useState<Range | null>(null);
  const range = useMemo(() => custom ?? monthRange(month, today), [custom, month, today]);
  const title = custom ? `${formatDate(range.from, locale)} – ${formatDate(range.to, locale)}` : monthName(month, locale);

  function open(next: Tab, nextView?: CostsView) {
    setParams(nextView ? { tab: next, view: nextView } : { tab: next });
    window.scrollTo({ top: 0 });
  }

  // "Right now" lists and the place costs are typed in take no period.
  const dated = tab !== 'courier' && !(tab === 'costs' && (view === 'products' || view === 'runs'));

  const shell = (content: ReactNode) => (
    <div className="space-y-4">
      <h1 className="no-print text-lg font-extrabold">{t('analytics.title')}</h1>

      <div className="no-print -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => open(value)}
            className={cx(
              'min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold transition-colors',
              tab === value ? 'bg-duch-ink text-white' : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
            )}
          >
            {t(`reportsPage.tab.${value}`)}
          </button>
        ))}
      </div>

      {dated ? (
        <Card className="no-print space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* The arrows follow the reading direction: forward in time is onward. */}
            <Button
              variant="secondary"
              className="min-h-10 px-2.5"
              aria-label={t('reportsPage.previousMonth')}
              onClick={() => {
                setCustom(null);
                setMonth((current) => addMonths(current, -1));
              }}
            >
              <ChevronRight className="h-4 w-4 ltr:rotate-180" aria-hidden />
            </Button>
            <p className="min-w-32 flex-1 text-center text-base font-extrabold sm:flex-none">{title}</p>
            <Button
              variant="secondary"
              className="min-h-10 px-2.5"
              aria-label={t('reportsPage.nextMonth')}
              disabled={!custom && month >= today.slice(0, 7)}
              onClick={() => {
                setCustom(null);
                setMonth((current) => addMonths(current, 1));
              }}
            >
              <ChevronLeft className="h-4 w-4 ltr:rotate-180" aria-hidden />
            </Button>
            <button
              type="button"
              onClick={() => setCustom((current) => (current ? null : range))}
              className="ms-auto text-xs font-semibold text-stone-500 underline underline-offset-2 hover:text-duch-ink"
            >
              {custom ? t('reportsPage.backToMonths') : t('reportsPage.customRange')}
            </button>
          </div>
          {custom ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-bold text-stone-500">{t('analytics.from')}</span>
                <Input
                  type="date"
                  value={custom.from}
                  max={custom.to}
                  onChange={(event) => event.target.value && setCustom({ ...custom, from: event.target.value })}
                  className="tabular"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-bold text-stone-500">{t('analytics.to')}</span>
                <Input
                  type="date"
                  value={custom.to}
                  min={custom.from}
                  max={today}
                  onChange={(event) => event.target.value && setCustom({ ...custom, to: event.target.value })}
                  className="tabular"
                />
              </label>
            </div>
          ) : null}
          {PROFIT_TABS.includes(tab as (typeof PROFIT_TABS)[number]) && tab !== 'costs' ? <p className="text-xs text-stone-500">{t('reportsPage.rule')}</p> : null}
        </Card>
      ) : null}

      {content}
    </div>
  );

  return mayProfit ? (
    <WithProfit tab={tab} view={view} range={range} title={title} open={open} shell={shell} />
  ) : (
    <OpsOnly tab={tab} range={range} shell={shell} />
  );
}

/** A new period keeps the page as it was, faded, until its numbers arrive. */
function Loaded({ loading, children }: { loading: boolean; children: ReactNode }) {
  return <div className={cx('transition-opacity', loading && 'pointer-events-none opacity-50')}>{children}</div>;
}

function WithProfit({
  tab,
  view,
  range,
  title,
  open,
  shell,
}: {
  tab: Tab;
  view: CostsView;
  range: Range;
  title: string;
  open: (tab: Tab, view?: CostsView) => void;
  shell: (content: ReactNode) => ReactNode;
}) {
  const { t } = useLocale();
  const { model, loading, error, reloadBooks } = useProfitModel(range);

  if (tab === 'courier') return shell(<CourierTab />);
  if (tab === 'money') return shell(<MoneyTab range={range} />);
  return shell(
    <>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!model ? (
        error ? null : (
          <ListSkeleton label={t('app.loading')} />
        )
      ) : (
        <Loaded loading={loading || model.range !== range}>
          {tab === 'profit' ? <ProfitTab model={model} onOpenCosts={() => open('costs', 'products')} /> : null}
          {tab === 'monthly' ? <MonthlyReport model={model} title={title} onAddExpense={() => open('costs', 'expenses')} onChanged={reloadBooks} /> : null}
          {tab === 'costs' ? <CostsTab model={model} view={view} onView={(next) => open('costs', next)} onChanged={reloadBooks} /> : null}
          {tab === 'returns' ? <ReturnsTab rows={model.rows} range={model.range} /> : null}
          {tab === 'refusals' ? <RefusalsTab rows={model.rows} range={model.range} /> : null}
        </Loaded>
      )}
    </>,
  );
}

function OpsOnly({ tab, range, shell }: { tab: Tab; range: Range; shell: (content: ReactNode) => ReactNode }) {
  const { t } = useLocale();
  const { data, loading, error } = useSalesRows(range.from);

  if (tab === 'courier') return shell(<CourierTab />);
  if (tab === 'money') return shell(<MoneyTab range={range} />);
  return shell(
    <>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!data ? (
        error ? null : (
          <ListSkeleton label={t('app.loading')} />
        )
      ) : (
        <Loaded loading={loading}>{tab === 'refusals' ? <RefusalsTab rows={data} range={range} /> : <ReturnsTab rows={data} range={range} />}</Loaded>
      )}
    </>,
  );
}
