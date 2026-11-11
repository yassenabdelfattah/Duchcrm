import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { cairoDate, formatEGP } from '@duch/shared';
import { WAITING, daysBetween, type StandingOrder } from '../../lib/reportMath';
import type { ProductProfit, ProfitRow } from '../../lib/profitMath';
import { useLocale } from '../../i18n';
import { Card, cx } from '../../components/ui';
import { DataTable, Panel, wholeEGP, type Column } from './parts';
import { Statement } from './Statement';
import type { ProfitModel } from './model';

type T = (key: string, params?: Record<string, unknown>) => string;

/**
 * Profit for a period, top to bottom: the one number, the statement that
 * arrives at it, what each product made, the gift fund, and what of the
 * period is not counted yet. Every figure here is of sales that are
 * delivered and paid for, in the period they were ordered.
 */
export function ProfitTab({ model, onOpenCosts }: { model: ProfitModel; onOpenCosts: () => void }) {
  const { t, locale } = useLocale();
  const { report, done, fund } = model;
  const money = (value: number) => formatEGP(value, locale);

  return (
    <div className="space-y-4">
      {report.uncosted.length > 0 ? (
        <Notice
          action={
            <button type="button" onClick={onOpenCosts} className="font-bold underline underline-offset-2">
              {t('profit.uncosted.action')}
            </button>
          }
        >
          {t('profit.uncosted.body', {
            count: report.uncosted.length,
            names: report.uncosted
              .slice(0, 3)
              .map((row) => row.title)
              .join('، '),
          })}
        </Notice>
      ) : null}
      {report.courierDraft.count > 0 ? (
        <Notice>{t('profit.draftNotice', { count: report.courierDraft.count, amount: money(report.courierDraft.amount) })}</Notice>
      ) : null}

      {/* The one number, and the three that say where it came from. */}
      <Card className="space-y-3">
        <div>
          <p className="text-xs font-bold text-stone-500">{t('profit.line.net')}</p>
          <p className={cx('tabular text-3xl font-extrabold leading-tight', report.net < 0 && 'text-red-700')}>
            {wholeEGP(report.net, locale)}
          </p>
          <p className="text-xs text-stone-500">
            {report.margin === null ? t('profit.nothingSold') : t('profit.marginOf', { percent: Math.round(report.margin * 100) })}
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-3 border-t border-duch-line pt-3 text-sm">
          <Figure label={t('profit.figure.sales')} value={wholeEGP(report.sales, locale)} />
          <Figure label={t('profit.figure.pieces')} value={String(report.pieces)} />
          <Figure label={t('profit.figure.orders')} value={String(done.orders)} hint={t('profit.figure.ofPlaced', { count: done.placed })} />
        </dl>
      </Card>

      <Panel title={t('profit.statementTitle')} help={t('profit.statementHelp')}>
        <Statement report={report} orders={done.orders} />
      </Panel>

      <Panel title={t('profit.productsTitle')} help={t('profit.productsHelp')}>
        <ProductTable rows={report.products} />
      </Panel>

      <Panel title={t('profit.fund.title')} help={t('profit.fund.help')}>
        <FundLines fund={fund} />
      </Panel>

      <Panel title={t('profit.waiting.title')} help={t('profit.waiting.help')}>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          {WAITING.map((standing) => (
            <div key={standing} className="rounded-lg bg-stone-50 p-3">
              <dt className="text-xs font-bold text-stone-500">{t(`profit.waiting.${standing}`)}</dt>
              <dd className="tabular text-lg font-extrabold">
                {wholeEGP(done.byStanding[standing].net, locale)}
              </dd>
              <dd className="text-xs text-stone-500">{t('profit.waiting.count', { orders: done.byStanding[standing].orders, pieces: done.byStanding[standing].pieces })}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-stone-500">
          {t('profit.waiting.addsUp', {
            placed: done.placed,
            completed: done.orders,
            waiting: WAITING.reduce((total, standing) => total + done.byStanding[standing].orders, 0),
            back: done.byStanding.cameBack.orders,
          })}
        </p>
        <DataTable
          columns={waitingColumns(t, locale)}
          rows={done.waiting}
          rowKey={(row) => row.order_id}
          fileName={`not-counted-${model.range.from}-${model.range.to}`}
          empty={t('profit.waiting.none')}
          limit={8}
        />
      </Panel>
    </div>
  );
}

function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="no-print flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {children} {action}
      </p>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-stone-500">{label}</dt>
      <dd className="tabular text-lg font-extrabold">
        {value}
      </dd>
      {hint ? <dd className="text-xs text-stone-500">{hint}</dd> : null}
    </div>
  );
}

/** The gift fund over the period: what it held, what came in, what went out, what it holds. */
export function FundLines({ fund }: { fund: ProfitModel['fund'] }) {
  const { t, locale } = useLocale();
  const money = (value: number) => formatEGP(value, locale);
  return (
    <dl className="space-y-2 text-sm">
      <FundLine label={t('profit.fund.opening')} value={money(fund.opening)} />
      <FundLine label={t('profit.fund.collected')} value={`+${money(fund.collected)}`} />
      <FundLine label={t('profit.fund.spent')} value={fund.spent === 0 ? money(0) : money(-fund.spent)} />
      {fund.rows.map((row) => (
        <div key={row.id} className="flex items-baseline justify-between gap-3 ps-4 text-xs text-stone-500">
          <dt className="min-w-0">
            <bdi>{row.note ? `${row.category} · ${row.note}` : row.category}</bdi>
          </dt>
          <dd className="tabular shrink-0">
            {money(Number(row.amount_egp))}
          </dd>
        </div>
      ))}
      <div className={cx('flex items-baseline justify-between gap-3 border-t border-duch-line pt-2 font-extrabold', fund.closing < 0 && 'text-red-700')}>
        <dt>{t('profit.fund.closing')}</dt>
        <dd className="tabular">
          {money(fund.closing)}
        </dd>
      </div>
    </dl>
  );
}

function FundLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-stone-600">{label}</dt>
      <dd className="tabular font-semibold">
        {value}
      </dd>
    </div>
  );
}

/**
 * Each product: what it sold, what that cost, and what is left. A row opens
 * to its sizes and colours, and to what one piece is made of.
 */
function ProductTable({ rows }: { rows: ProductProfit[] }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const money = (value: number) => formatEGP(value, locale);
  if (rows.length === 0) return <p className="text-sm text-stone-500">{t('profit.nothingSold')}</p>;

  const cells = (row: ProfitRow) => (
    <>
      <td className="tabular py-2 pe-3 text-end">{row.pieces}</td>
      <td className="tabular py-2 pe-3 text-end">
        {money(row.sales)}
      </td>
      <td className="tabular py-2 pe-3 text-end">
        {row.costed ? money(row.cost) : '—'}
      </td>
      <td className="tabular hidden py-2 pe-3 text-end sm:table-cell">
        {money(row.lossReserve + row.giftReserve)}
      </td>
      <td className="tabular hidden py-2 pe-3 text-end sm:table-cell">
        {money(row.ads)}
      </td>
      <td className={cx('tabular py-2 pe-3 text-end font-bold', row.profit < 0 && 'text-red-700')}>
        {money(row.profit)}
      </td>
      <td className="tabular hidden py-2 text-end text-stone-500 sm:table-cell">
        {row.perPiece === null ? '—' : money(row.perPiece)}
      </td>
    </>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-duch-line text-xs text-stone-500">
            <th className="py-2 text-start font-bold">{t('profit.col.product')}</th>
            <th className="py-2 pe-3 text-end font-bold">{t('profit.col.pieces')}</th>
            <th className="py-2 pe-3 text-end font-bold">{t('profit.col.sales')}</th>
            <th className="py-2 pe-3 text-end font-bold">{t('profit.col.cost')}</th>
            <th className="hidden py-2 pe-3 text-end font-bold sm:table-cell">{t('profit.col.reserves')}</th>
            <th className="hidden py-2 pe-3 text-end font-bold sm:table-cell">{t('profit.col.ads')}</th>
            <th className="py-2 pe-3 text-end font-bold">{t('profit.col.profit')}</th>
            <th className="hidden py-2 text-end font-bold sm:table-cell">{t('profit.col.perPiece')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.key}>
              <tr className="cursor-pointer border-b border-stone-100 hover:bg-stone-50" onClick={() => setOpen((current) => (current === row.key ? null : row.key))}>
                <td className="py-2 pe-3">
                  <span className="flex items-center gap-1.5">
                    <ChevronDown className={cx('no-print h-4 w-4 shrink-0 text-stone-400 transition-transform', open === row.key && 'rotate-180')} aria-hidden />
                    <bdi className="font-semibold">{row.title}</bdi>
                    {!row.costed ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">{t('profit.noCost')}</span> : null}
                  </span>
                </td>
                {cells(row)}
              </tr>
              {open === row.key ? (
                <>
                  {row.variants.map((variant) => (
                    <tr key={variant.key} className="border-b border-stone-100 bg-stone-50 text-xs">
                      <td className="py-2 pe-3 ps-6">
                        <bdi>{variant.detail ?? variant.sku ?? '—'}</bdi>
                      </td>
                      {cells(variant)}
                    </tr>
                  ))}
                  <tr className="border-b border-stone-100 bg-stone-50 text-xs">
                    <td colSpan={8} className="py-2 ps-6">
                      {row.breakdown ? (
                        <span className="flex flex-wrap gap-x-4 gap-y-1 text-stone-600">
                          <span className="font-bold">{t('profit.pieceMadeOf')}</span>
                          {row.breakdown.map((line, index) => (
                            <span key={index}>
                              <bdi>{line.label}</bdi>{' '}
                              <span className="tabular font-semibold">
                                {money(line.amount)}
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-amber-800">{t('profit.noCostLong')}</span>
                      )}
                    </td>
                  </tr>
                </>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An order not counted yet: where it is, and for how long since it was placed. */
function waitingColumns(t: T, locale: 'ar' | 'en'): Column<StandingOrder>[] {
  const today = cairoDate();
  return [
    {
      key: 'order',
      label: t('analytics.col.order'),
      value: (row) => row.order_number,
      render: (row) => (
        <Link to={`/orders?q=${encodeURIComponent(row.order_number)}`} className="tabular font-semibold underline decoration-stone-300 underline-offset-2" dir="ltr">
          {row.order_number}
        </Link>
      ),
    },
    { key: 'customer', label: t('analytics.col.customer'), value: (row) => row.customer_name, render: (row) => <bdi>{row.customer_name ?? '—'}</bdi> },
    { key: 'standing', label: t('profit.waiting.where'), value: (row) => t(`profit.waiting.${row.standing}`) },
    { key: 'days', label: t('analytics.col.days'), value: (row) => daysBetween(row.placed_on, today) - 1, numeric: true },
    { key: 'pieces', label: t('analytics.col.pieces'), value: (row) => row.pieces, numeric: true },
    { key: 'net', label: t('analytics.col.goods'), value: (row) => row.net, render: (row) => formatEGP(row.net, locale), numeric: true },
  ];
}
