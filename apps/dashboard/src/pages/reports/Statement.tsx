import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronDown } from 'lucide-react';
import { formatDate, formatEGP } from '@duch/shared';
import type { ProfitReport } from '../../lib/profitMath';
import { useLocale } from '../../i18n';
import { cx } from '../../components/ui';

/**
 * The profit statement: one column of numbers, top to bottom, each line
 * taking the one above it to the next. A line that is made of other things
 * opens to show them, so any number can be checked against what is behind it.
 *
 * `flat` is the same statement with nothing to open, for paper.
 */

function Row({
  sign,
  label,
  hint,
  amount,
  strong,
  total,
  children,
  flat,
}: {
  sign?: '+' | '−' | '=';
  label: string;
  hint?: string;
  amount: string;
  strong?: boolean;
  total?: boolean;
  children?: ReactNode;
  flat?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const canOpen = Boolean(children) && !flat;
  const body = (
    <>
      <span className="w-4 shrink-0 text-center font-bold text-stone-400" aria-hidden>
        {sign ?? ''}
      </span>
      <span className="min-w-0 flex-1 text-start">
        <span className={cx('block', strong && 'font-extrabold')}>{label}</span>
        {hint ? <span className="block text-xs font-normal text-stone-500">{hint}</span> : null}
      </span>
      <span className={cx('tabular shrink-0', strong ? 'font-extrabold' : 'font-semibold')}>
        {amount}
      </span>
      {canOpen ? (
        <ChevronDown className={cx('no-print h-4 w-4 shrink-0 text-stone-400 transition-transform', open && 'rotate-180')} aria-hidden />
      ) : (
        <span className="no-print w-4 shrink-0" aria-hidden />
      )}
    </>
  );
  return (
    <div className={cx(total ? 'border-t-2 border-duch-ink' : 'border-t border-stone-100 first:border-t-0')}>
      {canOpen ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={cx('flex w-full items-start gap-2 py-2.5 text-sm hover:bg-stone-50', total && 'text-base')}
        >
          {body}
        </button>
      ) : (
        <div className={cx('flex items-start gap-2 py-2.5 text-sm', total && 'text-base')}>{body}</div>
      )}
      {canOpen && open ? <div className="mb-3 ms-6 rounded-lg bg-stone-50 p-3 text-xs">{children}</div> : null}
    </div>
  );
}

/** What is behind a line: a name and an amount per row. */
function Parts({ rows, empty }: { rows: Array<{ key: string; label: ReactNode; amount: string }>; empty?: string }) {
  if (rows.length === 0) return <p className="text-stone-500">{empty ?? '—'}</p>;
  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex items-baseline justify-between gap-3">
          <dt className="min-w-0 text-stone-600">{row.label}</dt>
          <dd className="tabular shrink-0 font-semibold">
            {row.amount}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Statement({ report, orders, flat }: { report: ProfitReport; orders: number; flat?: boolean }) {
  const { t, locale } = useLocale();
  const money = (value: number) => formatEGP(value, locale);
  // Money taken off, without a "-0.00" where nothing was.
  const less = (value: number) => (value === 0 ? money(0) : money(-value));
  const signed = (value: number) => (value > 0 ? `+${money(value)}` : money(value));

  return (
    <div>
      <Row label={t('profit.line.sales')} hint={t('profit.line.salesHint', { pieces: report.pieces, orders })} amount={money(report.sales)} strong flat={flat} />

      <Row sign="−" label={t('profit.line.manufacturing')} amount={less(report.manufacturing)} flat={flat}>
        <Parts
          rows={report.manufacturingLines.map((line) => ({ key: line.label, label: <bdi>{line.label}</bdi>, amount: money(line.amount) }))}
          empty={t('profit.noCostsYet')}
        />
      </Row>

      <Row sign="−" label={t('profit.line.lossReserve')} hint={t('profit.line.lossReserveHint')} amount={less(report.lossReserve)} flat={flat} />
      <Row sign="−" label={t('profit.line.giftReserve')} hint={t('profit.line.giftReserveHint')} amount={less(report.giftReserve)} flat={flat} />

      <Row sign="−" label={t('profit.line.ads')} hint={t('profit.line.adsHint')} amount={less(report.ads)} flat={flat}>
        <Parts
          rows={report.adRows.map((row) => ({
            key: row.id,
            label: (
              <span>
                <bdi>{row.note || t('profit.ads.meta')}</bdi>{' '}
                <span className="tabular text-stone-400">
                  {formatDate(row.from_date, locale)} – {formatDate(row.to_date, locale)}
                </span>
              </span>
            ),
            amount: money(row.share),
          }))}
          empty={t('profit.noAds')}
        />
      </Row>

      <Row sign="=" label={t('profit.line.productsProfit')} amount={money(report.productsProfit)} strong total flat={flat} />

      <Row
        sign={report.lossLeftover >= 0 ? '+' : '−'}
        label={t(report.lossLeftover >= 0 ? 'profit.line.lossLeftover' : 'profit.line.lossShort')}
        hint={t('profit.line.lossLeftoverHint', { reserve: money(report.lossReserve), cost: money(report.courier) })}
        amount={signed(report.lossLeftover)}
        flat={flat}
      >
        <div className="space-y-3">
          <Parts
            rows={[
              { key: 'reserve', label: t('profit.courier.reserve'), amount: money(report.lossReserve) },
              ...report.courierKinds.map((row) => ({
                key: row.kind,
                label: `${t(`profit.courier.kind.${row.kind}`)} (${row.count})`,
                amount: less(row.amount),
              })),
            ]}
          />
          {report.courierRows.length > 0 ? (
            <div className="overflow-x-auto border-t border-stone-200 pt-2">
              <table className="w-full">
                <tbody>
                  {report.courierRows.map((row) => (
                    <tr key={`${row.line_id}-${row.kind}`} className="border-b border-stone-100 last:border-b-0">
                      <td className="py-1 pe-2">
                        {row.order_number ? (
                          <Link to={`/orders?q=${encodeURIComponent(row.order_number)}`} className="tabular font-semibold underline decoration-stone-300 underline-offset-2" dir="ltr">
                            {row.order_number}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-1 pe-2 text-stone-600">{t(`profit.courier.kind.${row.kind}`)}</td>
                      <td className="tabular py-1 pe-2 text-stone-400" dir="ltr">
                        {row.reference ?? ''}
                      </td>
                      <td className="tabular py-1 text-end font-semibold">
                        {less(Number(row.cost_egp))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-stone-500">{t('profit.courier.none')}</p>
          )}
        </div>
      </Row>

      <Row sign="−" label={t('profit.line.fixed')} amount={less(report.fixed)} flat={flat}>
        <Parts
          rows={report.fixedCategories.map((row) => ({ key: row.category, label: <bdi>{row.category}</bdi>, amount: money(row.amount) }))}
          empty={t('profit.noFixed')}
        />
      </Row>

      {/* On paper the fixed costs are named, since nothing opens. */}
      {flat
        ? report.fixedCategories.map((row) => (
            <div key={row.category} className="flex items-baseline gap-2 py-1 ps-6 text-xs text-stone-600">
              <bdi className="flex-1">{row.category}</bdi>
              <span className="tabular">
                {money(row.amount)}
              </span>
              <span className="no-print w-4" aria-hidden />
            </div>
          ))
        : null}

      {report.giftStock.pieces > 0 ? (
        <Row
          sign="+"
          label={t('profit.line.giftStock')}
          hint={t('profit.line.giftStockHint', { pieces: report.giftStock.pieces, sales: money(report.giftStock.sales), cost: money(report.giftStock.cost) })}
          amount={signed(report.giftStock.profit)}
          flat={flat}
        />
      ) : null}

      <Row
        sign="="
        label={t('profit.line.net')}
        hint={report.margin === null ? undefined : t('profit.line.netHint', { percent: Math.round(report.margin * 100) })}
        amount={money(report.net)}
        strong
        total
        flat={flat}
      />
    </div>
  );
}
