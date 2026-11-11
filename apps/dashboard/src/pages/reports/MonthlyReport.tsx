import { useState, type ReactNode } from 'react';
import { FileSpreadsheet, Printer, Settings2 } from 'lucide-react';
import { formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { WAITING } from '../../lib/reportMath';
import { useLocale } from '../../i18n';
import { Button, Card, ErrorNote, Modal, cx, toast } from '../../components/ui';
import { wholeEGP } from './parts';
import { Statement } from './Statement';
import { FundLines } from './ProfitTab';
import type { ProfitModel } from './model';

/**
 * The month on one page: the same figures as the profit screen, laid out to
 * be printed, saved as a PDF, or downloaded as a spreadsheet. Which parts
 * show is the owner's choice and is remembered; the numbers themselves are
 * never typed here - an expense missing from it is added under المصروفات.
 */

export const REPORT_SECTIONS = ['headline', 'best', 'statement', 'spending', 'variants', 'reserve', 'fund', 'waiting'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

type Cell = string | number | null;

export function MonthlyReport({
  model,
  title,
  onAddExpense,
  onChanged,
}: {
  model: ProfitModel;
  /** The period in words: "أكتوبر 2026", or the two dates. */
  title: string;
  onAddExpense: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useLocale();
  const { report, done, fund, books, range } = model;
  const money = (value: number) => formatEGP(value, locale);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hidden = new Set(books.settings.report_hidden);
  const shows = (section: ReportSection) => !hidden.has(section);
  const best = report.variants.filter((row) => row.pieces > 0).sort((a, b) => b.pieces - a.pieces || b.sales - a.sales);
  const name = (row: { title: string; detail: string | null }) => [row.title, row.detail].filter(Boolean).join(' · ');

  async function download() {
    setError(null);
    try {
      // Rows of [label, pieces, amount]: one sheet, the parts one under the other.
      const rows: Cell[][] = [[t('profit.monthly.title'), null, null], [title, null, null], [`${formatDate(range.from, locale)} – ${formatDate(range.to, locale)}`, null, null], []];
      const part = (heading: string, lines: Cell[][]) => rows.push([heading, null, null], ...lines, []);

      if (shows('headline')) {
        part(t('profit.monthly.section.headline'), [
          [t('profit.line.net'), null, report.net],
          [t('profit.figure.sales'), report.pieces, report.sales],
          [t('profit.figure.orders'), done.orders, null],
        ]);
      }
      if (shows('best')) part(t('profit.monthly.section.best'), best.slice(0, 5).map((row) => [name(row), row.pieces, row.sales]));
      if (shows('statement')) {
        part(t('profit.monthly.section.statement'), [
          [t('profit.line.sales'), report.pieces, report.sales],
          [t('profit.line.manufacturing'), null, -report.manufacturing],
          ...report.manufacturingLines.map((line): Cell[] => [`   ${line.label}`, null, -line.amount]),
          [t('profit.line.lossReserve'), null, -report.lossReserve],
          [t('profit.line.giftReserve'), null, -report.giftReserve],
          [t('profit.line.ads'), null, -report.ads],
          [t('profit.line.productsProfit'), null, report.productsProfit],
          [t(report.lossLeftover >= 0 ? 'profit.line.lossLeftover' : 'profit.line.lossShort'), null, report.lossLeftover],
          [t('profit.line.fixed'), null, -report.fixed],
          ...report.fixedCategories.map((row): Cell[] => [`   ${row.category}`, null, -row.amount]),
          ...(report.giftStock.pieces > 0 ? [[t('profit.line.giftStock'), report.giftStock.pieces, report.giftStock.profit] as Cell[]] : []),
          [t('profit.line.net'), null, report.net],
        ]);
      }
      if (shows('spending')) {
        part(t('profit.monthly.section.spending'), [
          [t('profit.line.ads'), null, report.ads],
          ...report.fixedCategories.map((row): Cell[] => [row.category, null, row.amount]),
          [t('profit.monthly.giveaways'), null, fund.spent],
          ...fund.rows.map((row): Cell[] => [`   ${row.note ? `${row.category} · ${row.note}` : row.category}`, null, Number(row.amount_egp)]),
        ]);
      }
      if (shows('variants')) {
        part(t('profit.monthly.section.variants'), [
          [t('profit.col.product'), t('profit.col.pieces'), t('profit.col.profit')],
          ...report.variants.map((row): Cell[] => [name(row), row.pieces, row.profit]),
          [t('profit.line.productsProfit'), report.pieces, report.productsProfit],
        ]);
      }
      if (shows('reserve')) {
        part(t('profit.monthly.section.reserve'), [
          [t('profit.courier.reserve'), null, report.lossReserve],
          ...report.courierKinds.map((row): Cell[] => [t(`profit.courier.kind.${row.kind}`), row.count, -row.amount]),
          [t(report.lossLeftover >= 0 ? 'profit.line.lossLeftover' : 'profit.line.lossShort'), null, report.lossLeftover],
        ]);
      }
      if (shows('fund')) {
        part(t('profit.monthly.section.fund'), [
          [t('profit.fund.opening'), null, fund.opening],
          [t('profit.fund.collected'), null, fund.collected],
          [t('profit.fund.spent'), null, -fund.spent],
          [t('profit.fund.closing'), null, fund.closing],
        ]);
      }
      if (shows('waiting')) {
        part(
          t('profit.monthly.section.waiting'),
          WAITING.map((standing) => [t(`profit.waiting.${standing}`), done.byStanding[standing].orders, done.byStanding[standing].net]),
        );
      }

      // Loaded when asked for: nobody else pays for it.
      const { default: writeExcelFile } = await import('write-excel-file/browser');
      const blob = await writeExcelFile(
        rows.map((row) =>
          row.map((cell) =>
            cell === null || cell === undefined
              ? null
              : typeof cell === 'number'
                ? { value: cell, type: Number, format: '#,##0.00' }
                : { value: cell, type: String },
          ),
        ),
        { sheet: title.slice(0, 31), rightToLeft: true, columns: [{ width: 46 }, { width: 12 }, { width: 18 }] },
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `duch-${range.from}-${range.to}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(arabicError(caught as { message?: string }));
    }
  }

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="min-h-10 text-xs" onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden />
          {t('profit.monthly.pdf')}
        </Button>
        <Button variant="secondary" className="min-h-10 text-xs" onClick={() => void download()}>
          <FileSpreadsheet className="h-4 w-4" aria-hidden />
          {t('profit.monthly.excel')}
        </Button>
        <Button variant="ghost" className="ms-auto min-h-10 text-xs" onClick={() => setEditing(true)}>
          <Settings2 className="h-4 w-4" aria-hidden />
          {t('profit.monthly.edit')}
        </Button>
      </div>
      <p className="no-print text-xs text-stone-500">{t('profit.monthly.pdfHint')}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {/* The page itself. */}
      <Card className="print-page space-y-6">
        <header className="flex items-end justify-between gap-3 border-b-2 border-duch-ink pb-3">
          <div>
            <h2 className="text-lg font-extrabold">{t('profit.monthly.title')}</h2>
            <p className="text-sm font-semibold">{title}</p>
          </div>
          <p className="tabular text-xs text-stone-500">
            {formatDate(range.from, locale)} – {formatDate(range.to, locale)}
          </p>
        </header>

        {shows('headline') ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Big label={t('profit.line.net')} value={wholeEGP(report.net, locale)} hint={report.margin === null ? undefined : t('profit.marginOf', { percent: Math.round(report.margin * 100) })} bad={report.net < 0} />
            <Big label={t('profit.figure.sales')} value={wholeEGP(report.sales, locale)} />
            <Big label={t('profit.figure.pieces')} value={String(report.pieces)} />
            <Big label={t('profit.figure.orders')} value={String(done.orders)} />
          </dl>
        ) : null}

        {shows('best') && best.length > 0 ? (
          <Part title={t('profit.monthly.section.best')}>
            <Table
              head={[t('profit.col.product'), t('profit.col.pieces'), t('profit.col.sales')]}
              rows={best.slice(0, 5).map((row) => [<bdi key="n">{name(row)}</bdi>, row.pieces, money(row.sales)])}
            />
          </Part>
        ) : null}

        {shows('statement') ? (
          <Part title={t('profit.monthly.section.statement')}>
            <Statement report={report} orders={done.orders} flat />
          </Part>
        ) : null}

        {shows('spending') ? (
          <Part title={t('profit.monthly.section.spending')}>
            <Table
              head={[t('profit.monthly.what'), '', t('profit.amount')]}
              rows={[
                [t('profit.line.ads'), '', money(report.ads)],
                ...report.fixedCategories.map((row) => [<bdi key="n">{row.category}</bdi>, '', money(row.amount)]),
                [t('profit.monthly.giveaways'), '', money(fund.spent)],
              ]}
              foot={[t('analytics.total'), '', money(report.ads + report.fixed + fund.spent)]}
            />
            <button type="button" onClick={onAddExpense} className="no-print text-xs font-semibold text-stone-500 underline underline-offset-2 hover:text-duch-ink">
              {t('profit.monthly.addExpense')}
            </button>
          </Part>
        ) : null}

        {shows('variants') ? (
          <Part title={t('profit.monthly.section.variants')}>
            {report.variants.length === 0 ? (
              <p className="text-sm text-stone-500">{t('profit.nothingSold')}</p>
            ) : (
              <Table
                head={[t('profit.col.product'), t('profit.col.pieces'), t('profit.col.profit')]}
                rows={report.variants.map((row) => [<bdi key="n">{name(row)}</bdi>, row.pieces, money(row.profit)])}
                foot={[t('profit.line.productsProfit'), report.pieces, money(report.productsProfit)]}
              />
            )}
          </Part>
        ) : null}

        {shows('reserve') ? (
          <Part title={t('profit.monthly.section.reserve')} help={t('profit.monthly.reserveHelp')}>
            <Table
              head={[t('profit.monthly.what'), t('profit.monthly.count'), t('profit.amount')]}
              rows={[
                [t('profit.courier.reserve'), '', money(report.lossReserve)],
                ...report.courierKinds.map((row) => [t(`profit.courier.kind.${row.kind}`), row.count, row.amount === 0 ? money(0) : money(-row.amount)]),
              ]}
              foot={[t(report.lossLeftover >= 0 ? 'profit.line.lossLeftover' : 'profit.line.lossShort'), '', money(report.lossLeftover)]}
            />
          </Part>
        ) : null}

        {shows('fund') ? (
          <Part title={t('profit.monthly.section.fund')} help={t('profit.fund.help')}>
            <FundLines fund={fund} />
          </Part>
        ) : null}

        {shows('waiting') ? (
          <Part title={t('profit.monthly.section.waiting')} help={t('profit.waiting.help')}>
            <Table
              head={[t('profit.waiting.where'), t('analytics.col.orders'), t('analytics.col.goods')]}
              rows={WAITING.map((standing) => [t(`profit.waiting.${standing}`), done.byStanding[standing].orders, money(done.byStanding[standing].net)])}
            />
          </Part>
        ) : null}

        {REPORT_SECTIONS.every((section) => !shows(section)) ? <p className="text-sm text-stone-500">{t('profit.monthly.allHidden')}</p> : null}
      </Card>

      {editing ? (
        <SectionPicker
          hidden={books.settings.report_hidden}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function Big({ label, value, hint, bad }: { label: string; value: string; hint?: string; bad?: boolean }) {
  return (
    <div className="rounded-lg bg-stone-50 p-3">
      <dt className="text-xs font-bold text-stone-500">{label}</dt>
      <dd className={cx('tabular text-xl font-extrabold', bad && 'text-red-700')}>
        {value}
      </dd>
      {hint ? <dd className="text-xs text-stone-500">{hint}</dd> : null}
    </div>
  );
}

function Part({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 break-inside-avoid">
      <div>
        <h3 className="text-sm font-extrabold">{title}</h3>
        {help ? <p className="text-xs text-stone-500">{help}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A plain three-column table: a name, a count, an amount. */
function Table({ head, rows, foot }: { head: string[]; rows: ReactNode[][]; foot?: ReactNode[] }) {
  const cell = (index: number) => cx('py-1.5', index === 0 ? 'text-start' : 'tabular ps-3 text-end');
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-duch-line text-xs text-stone-500">
          {head.map((label, index) => (
            <th key={index} className={cx(cell(index), 'font-bold')}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, at) => (
          <tr key={at} className="border-b border-stone-100">
            {row.map((value, index) => (
              <td key={index} className={cell(index)}>
                {value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {foot ? (
        <tfoot>
          <tr className="font-extrabold">
            {foot.map((value, index) => (
              <td key={index} className={cell(index)}>
                {value}
              </td>
            ))}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/** Which parts the report shows. Remembered for next month. */
function SectionPicker({ hidden, onClose, onSaved }: { hidden: string[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const [off, setOff] = useState<Set<string>>(new Set(hidden));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const { error: failed } = await supabase.from('profit_settings').update({ report_hidden: [...off] }).eq('id', true);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.saved'));
    onSaved();
  }

  return (
    <Modal open title={t('profit.monthly.edit')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-stone-500">{t('profit.monthly.editHelp')}</p>
        <div className="space-y-1">
          {REPORT_SECTIONS.map((section) => (
            <label key={section} className="flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-stone-50">
              <input
                type="checkbox"
                checked={!off.has(section)}
                onChange={() =>
                  setOff((current) => {
                    const next = new Set(current);
                    if (next.has(section)) next.delete(section);
                    else next.add(section);
                    return next;
                  })
                }
                className="h-4 w-4"
              />
              <span className="text-sm font-semibold">{t(`profit.monthly.section.${section}`)}</span>
            </label>
          ))}
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" onClick={() => void save()}>
          {t('profit.save')}
        </Button>
      </div>
    </Modal>
  );
}
