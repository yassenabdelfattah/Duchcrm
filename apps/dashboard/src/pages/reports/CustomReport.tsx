import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Download, Printer } from 'lucide-react';
import { formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import {
  byChannel,
  byColor,
  byDay,
  byGovernorate,
  byProduct,
  bySize,
  byVariant,
  daysBetween,
  leaveOutOpen,
  moneyIn,
  moneyWithCouriers,
  openInRange,
  rollUp,
  summarize,
  toCsvSections,
  type Range,
} from '../../lib/reportMath';
import { useLocale } from '../../i18n';
import { BarList } from '../../components/charts';
import { Button, Card, ErrorNote, Input, cx, toast } from '../../components/ui';
import { DataTable, Panel, percent } from './parts';
import { Line, courierMoneyColumns, dayColumns, groupColumns, itemColumns, moneyInColumns, piecesNote } from './columns';
import type { Column } from './parts';
import type { ReportData } from './useReportData';

/**
 * A report put together by hand: the date range on the page, the parts
 * ticked here, and whether the orders still open in the range count. It can
 * be kept by name (saved_reports), printed as one page, or downloaded as one
 * spreadsheet.
 *
 * Open orders count by default, as in every other report - sold the day they
 * were ordered. Leaving them out shows only what reached the customer or came
 * back, which is what a return rate is firmer on.
 */

export const SECTIONS = [
  'summary',
  'moneyIn',
  'withCourier',
  'returnRate',
  'top',
  'variants',
  'products',
  'sizes',
  'colors',
  'days',
  'channels',
  'governorates',
] as const;

type Section = (typeof SECTIONS)[number];

const STARTER: Section[] = ['summary', 'returnRate', 'top', 'variants'];

interface SavedReport {
  id: string;
  name: string;
  sections: string[];
  include_open: boolean;
}

/** The parts of a saved report this version knows, in the order they are shown. */
const known = (sections: string[]): Section[] => SECTIONS.filter((section) => sections.includes(section));

export function CustomReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  const [params, setParams] = useSearchParams();
  const openId = params.get('id');

  const [saved, setSaved] = useState<SavedReport[] | null>(null);
  const [name, setName] = useState('');
  const [sections, setSections] = useState<Section[]>(STARTER);
  const [includeOpen, setIncludeOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadSaved = useCallback(async () => {
    const { data: rows, error: loadError } = await supabase
      .from('saved_reports')
      .select('id, name, sections, include_open')
      .order('name');
    if (loadError) setError(arabicError(loadError));
    setSaved((rows ?? []) as SavedReport[]);
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const current = saved?.find((report) => report.id === openId) ?? null;

  // Opening a saved report puts its parts on the page.
  useEffect(() => {
    if (!current) return;
    setName(current.name);
    setSections(known(current.sections));
    setIncludeOpen(current.include_open);
    setConfirmDelete(false);
  }, [current]);

  const changed =
    current === null ||
    name.trim() !== current.name ||
    includeOpen !== current.include_open ||
    sections.join(',') !== known(current.sections).join(',');

  function openReport(id: string | null) {
    setError(null);
    setConfirmDelete(false);
    if (id === null) {
      setName('');
      setSections(STARTER);
      setIncludeOpen(true);
      setParams({ r: 'custom' });
    } else {
      setParams({ r: 'custom', id });
    }
  }

  function toggle(section: Section) {
    setSections((chosen) =>
      chosen.includes(section) ? chosen.filter((value) => value !== section) : SECTIONS.filter((value) => value === section || chosen.includes(value)),
    );
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('analytics.custom.nameRequired'));
      return;
    }
    if (sections.length === 0) {
      setError(t('analytics.custom.pickOne'));
      return;
    }

    setBusy(true);
    setError(null);
    const row = { name: trimmed, sections, include_open: includeOpen };
    const result = current
      ? await supabase.from('saved_reports').update(row).eq('id', current.id).select('id').single()
      : await supabase.from('saved_reports').insert(row).select('id').single();
    setBusy(false);

    if (result.error) {
      setError(result.error.code === '23505' ? t('analytics.custom.nameTaken') : arabicError(result.error));
      return;
    }
    await loadSaved();
    toast(t('analytics.custom.savedNotice'));
    setParams({ r: 'custom', id: (result.data as { id: string }).id });
  }

  async function remove() {
    if (!current) return;
    setBusy(true);
    const { error: deleteError } = await supabase.from('saved_reports').delete().eq('id', current.id);
    setBusy(false);
    if (deleteError) {
      setError(arabicError(deleteError));
      return;
    }
    await loadSaved();
    openReport(null);
  }

  // --- The numbers ----------------------------------------------------------------------------

  const open = useMemo(() => openInRange(data.lines, data.orders, range), [data, range]);
  const scoped = useMemo(() => (includeOpen ? data : leaveOutOpen(data)), [data, includeOpen]);
  const total = useMemo(() => summarize(scoped.lines, scoped.returns, scoped.orders, range), [scoped, range]);
  const grain = daysBetween(range.from, range.to) > 62 ? 'week' : 'day';

  const money = (value: number) => formatEGP(value, locale);
  const less = (value: number) => (value === 0 ? money(0) : money(-value));
  const piecesBackRate = total.units > 0 ? total.unitsReturned / total.units : null;
  const title = name.trim() || t('analytics.custom.untitled');
  const period = t('analytics.custom.period', { from: formatDate(range.from, locale), to: formatDate(range.to, locale) });

  // Each part as what it shows and what it downloads as, from the same rows.
  const parts = useMemo(() => {
    const items = {
      variants: { view: 'variant' as const, rows: byVariant(scoped.lines, scoped.returns, range) },
      products: { view: 'product' as const, rows: byProduct(scoped.lines, scoped.returns, range) },
      sizes: { view: 'size' as const, rows: bySize(scoped.lines, scoped.returns, range) },
      colors: { view: 'color' as const, rows: byColor(scoped.lines, scoped.returns, range) },
    };
    const days = [...rollUp(byDay(scoped.lines, scoped.returns, scoped.orders, range), grain)].reverse();
    const channels = byChannel(scoped.orders, range);
    const governorates = byGovernorate(scoped.orders, range);
    const top = items.variants.rows.slice(0, 10);
    return { items, days, channels, governorates, top };
  }, [scoped, range, grain]);

  const summaryLines: Array<[string, string, number | string]> = [
    [t('analytics.col.gross'), money(total.gross), total.gross],
    [t('analytics.col.discounts'), less(total.discounts), -total.discounts],
    [t('analytics.col.returns'), less(total.returns), -total.returns],
    [t('analytics.col.net'), money(total.net), total.net],
    [t('analytics.col.orders'), String(total.orders), total.orders],
    [t('analytics.col.unitsSold'), String(total.units), total.units],
    [t('analytics.col.average'), money(total.averageOrder), total.averageOrder],
  ];
  // The money is what moved, whether or not the orders are still open.
  const cash = useMemo(() => moneyIn(data.moneyIn, range), [data, range]);
  const held = useMemo(() => moneyWithCouriers(data.withCouriers), [data]);
  const cashLines: Array<[string, string, number | string]> = [
    ...cash.bySource.map(
      (row): [string, string, number | string] => [
        `${t(`analytics.custom.money.from.${row.source}`)} (${row.count})`,
        money(row.amount),
        row.amount,
      ],
    ),
    [t('analytics.custom.money.totalIn'), money(cash.total), cash.total],
  ];
  const heldLines: Array<[string, string, number | string]> = [
    [`${t('analytics.custom.money.collected')} (${held.collected.count})`, money(held.collected.amount), held.collected.amount],
    [`${t('analytics.custom.money.out')} (${held.out.count})`, money(held.out.amount), held.out.amount],
    [`${t('analytics.custom.money.ownOut')} (${held.ownOut.count})`, money(held.ownOut.amount), held.ownOut.amount],
    [t('analytics.custom.money.totalHeld'), money(held.total), held.total],
  ];

  // Refused at the door: not sales, so not in the pieces sold or back above
  // them, but still worth seeing beside them.
  const refusedPieces = data.refusals
    .filter((line) => line.returned_on >= range.from && line.returned_on <= range.to)
    .reduce((count, line) => count + line.quantity, 0);
  const returnLines: Array<[string, string, number | string]> = [
    [t('analytics.col.unitsSold'), String(total.units), total.units],
    [t('analytics.col.unitsBack'), String(total.unitsReturned), total.unitsReturned],
    [t('analytics.custom.piecesReturnRate'), percent(piecesBackRate), percent(piecesBackRate)],
    [t('analytics.custom.refusedPieces'), String(refusedPieces), refusedPieces],
    [t('analytics.custom.refusalRate'), percent(total.refusalRate), percent(total.refusalRate)],
  ];

  const channelColumns = groupColumns(t, locale, { key: 'key', label: t('analytics.col.channel'), value: (row) => t(`channel.${row.key}`) });
  const areaColumns = groupColumns(t, locale, {
    key: 'key',
    label: t('analytics.col.governorate'),
    value: (row) => (row.key === '—' ? t('analytics.unknownArea') : row.key),
  });

  function download() {
    const table = <R,>(columns: Column<R>[], rows: R[]) => ({
      header: columns.map((column) => column.label),
      rows: rows.map((row) => columns.map((column) => column.value(row))),
    });
    const blocks = sections.map((section) => {
      const heading = t(`analytics.custom.section.${section}`);
      switch (section) {
        case 'summary':
          return { title: heading, header: [t('analytics.custom.item'), t('analytics.custom.value')], rows: summaryLines.map(([label, , value]) => [label, value]) };
        case 'returnRate':
          return { title: heading, header: [t('analytics.custom.item'), t('analytics.custom.value')], rows: returnLines.map(([label, , value]) => [label, value]) };
        case 'moneyIn': {
          const list = table(moneyInColumns(t, locale), cash.rows);
          return { title: heading, header: list.header, rows: [...list.rows, [], ...cashLines.map(([label, , value]) => [label, value])] };
        }
        case 'withCourier': {
          const list = table(courierMoneyColumns(t, locale), data.withCouriers);
          return { title: heading, header: list.header, rows: [...list.rows, [], ...heldLines.map(([label, , value]) => [label, value])] };
        }
        case 'top':
          return { title: heading, ...table(itemColumns(t, locale, 'variant'), parts.top) };
        case 'variants':
        case 'products':
        case 'sizes':
        case 'colors':
          return { title: heading, ...table(itemColumns(t, locale, parts.items[section].view), parts.items[section].rows) };
        case 'days':
          return { title: heading, ...table(dayColumns(t, locale, grain), parts.days) };
        case 'channels':
          return { title: heading, ...table(channelColumns, parts.channels) };
        case 'governorates':
          return { title: heading, ...table(areaColumns, parts.governorates) };
      }
    });
    const csv = toCsvSections(
      [[title], [t('analytics.from'), range.from, t('analytics.to'), range.to], [includeOpen ? t('analytics.custom.openCounted') : t('analytics.custom.openLeftOut')]],
      blocks,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title}-${range.from}-${range.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // --- The page --------------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Building it: not part of what is printed. */}
      <Card className="no-print space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="me-1 text-xs font-bold text-stone-500">{t('analytics.custom.saved')}</span>
          {(saved ?? []).map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => openReport(report.id)}
              className={cx(
                'min-h-9 rounded-full px-3 text-xs font-semibold transition-colors',
                report.id === openId ? 'bg-duch-ink text-white' : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
              )}
            >
              <bdi>{report.name}</bdi>
            </button>
          ))}
          <button
            type="button"
            onClick={() => openReport(null)}
            className={cx(
              'min-h-9 rounded-full px-3 text-xs font-semibold transition-colors',
              openId === null ? 'bg-duch-ink text-white' : 'border border-dashed border-duch-line bg-white text-stone-600 hover:bg-stone-50',
            )}
          >
            {t('analytics.custom.new')}
          </button>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-bold text-stone-500">{t('analytics.custom.name')}</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('analytics.custom.namePlaceholder')}
            maxLength={80}
          />
        </label>

        <div className="space-y-1.5">
          <p className="text-xs font-bold text-stone-500">{t('analytics.custom.sections')}</p>
          <div className="flex flex-wrap gap-1.5">
            {SECTIONS.map((section) => {
              const on = sections.includes(section);
              return (
                <button
                  key={section}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(section)}
                  className={cx(
                    'min-h-9 rounded-full px-3 text-xs font-semibold transition-colors',
                    on ? 'bg-duch-ink text-white' : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                  )}
                >
                  {t(`analytics.custom.section.${section}`)}
                </button>
              );
            })}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={includeOpen}
            onChange={(event) => setIncludeOpen(event.target.checked)}
          />
          <span>
            <span className="block font-semibold">{t('analytics.custom.includeOpen')}</span>
            <span className="block text-xs text-stone-500">{t('analytics.custom.includeOpenHelp')}</span>
          </span>
        </label>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={busy || !changed}>
            {busy ? t('app.loading') : t('analytics.custom.save')}
          </Button>
          {current ? (
            confirmDelete ? (
              <>
                <Button variant="secondary" className="text-red-700" onClick={() => void remove()} disabled={busy}>
                  {t('analytics.custom.confirmDelete')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  {t('app.cancel')}
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="text-red-700" onClick={() => setConfirmDelete(true)}>
                {t('analytics.custom.delete')}
              </Button>
            )
          ) : null}
          <span className="ms-auto flex gap-2">
            <Button variant="secondary" onClick={() => window.print()} disabled={sections.length === 0}>
              <Printer className="h-4 w-4" aria-hidden />
              {t('analytics.custom.print')}
            </Button>
            <Button variant="secondary" onClick={download} disabled={sections.length === 0}>
              <Download className="h-4 w-4" aria-hidden />
              {t('analytics.custom.download')}
            </Button>
          </span>
        </div>
      </Card>

      {/* What it says about itself, printed at the top. */}
      <Card className="space-y-1">
        <h2 className="text-base font-extrabold">
          <bdi>{title}</bdi>
        </h2>
        <p className="text-sm text-stone-600">{period}</p>
        <p className={cx('text-xs', open.orders > 0 ? 'text-amber-800' : 'text-stone-500')}>
          {open.orders > 0
            ? `${t('analytics.custom.openNote', { count: open.orders, value: money(open.net) })} ${
                includeOpen ? t('analytics.custom.openCounted') : t('analytics.custom.openLeftOut')
              }`
            : t('analytics.custom.noOpen')}
        </p>
      </Card>

      {sections.length === 0 ? <p className="text-sm text-stone-500">{t('analytics.custom.pickOne')}</p> : null}

      {sections.map((section) => {
        const heading = t(`analytics.custom.section.${section}`);
        switch (section) {
          case 'summary':
          case 'returnRate':
            return (
              <Panel key={section} title={heading}>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  {(section === 'summary' ? summaryLines : returnLines).map(([label, value]) => (
                    <Line key={label} label={label} value={value} strong={label === t('analytics.col.net')} />
                  ))}
                </dl>
              </Panel>
            );
          case 'moneyIn':
          case 'withCourier': {
            const isIn = section === 'moneyIn';
            const figures = isIn ? cashLines : heldLines;
            const totalLabel = t(isIn ? 'analytics.custom.money.totalIn' : 'analytics.custom.money.totalHeld');
            return (
              <Panel key={section} title={heading} help={t(isIn ? 'analytics.custom.money.inHelp' : 'analytics.custom.money.heldHelp')}>
                <div className="space-y-3">
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    {figures.map(([label, value]) => (
                      <Line key={label} label={label} value={value} strong={label === totalLabel} />
                    ))}
                  </dl>
                  {isIn ? (
                    <DataTable
                      columns={moneyInColumns(t, locale)}
                      rows={cash.rows}
                      rowKey={(row) => `${row.source}:${row.ref_id}`}
                      fileName={`money-in-${range.from}-${range.to}`}
                      empty={t('analytics.custom.money.noneIn')}
                    />
                  ) : (
                    <DataTable
                      columns={courierMoneyColumns(t, locale)}
                      rows={data.withCouriers}
                      rowKey={(row) => row.shipment_id}
                      fileName="money-with-couriers"
                      empty={t('analytics.custom.money.noneHeld')}
                    />
                  )}
                </div>
              </Panel>
            );
          }
          case 'top':
            return (
              <Panel key={section} title={heading}>
                <BarList
                  rows={parts.top.map((row) => ({
                    key: row.key,
                    label: (
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <bdi>{row.label}</bdi>
                        {row.detail ? <bdi className="text-xs text-stone-500">{row.detail}</bdi> : null}
                      </span>
                    ),
                    value: row.net,
                    note: piecesNote(t, row),
                  }))}
                  format={(value) => formatEGP(value, locale)}
                  empty={t('analytics.empty')}
                />
              </Panel>
            );
          case 'variants':
          case 'products':
          case 'sizes':
          case 'colors':
            return (
              <Panel key={section} title={heading}>
                <DataTable
                  columns={itemColumns(t, locale, parts.items[section].view)}
                  rows={parts.items[section].rows}
                  rowKey={(row) => row.key}
                  fileName={`${section}-${range.from}-${range.to}`}
                />
              </Panel>
            );
          case 'days':
            return (
              <Panel key={section} title={heading}>
                <DataTable
                  columns={dayColumns(t, locale, grain)}
                  rows={parts.days}
                  rowKey={(row) => row.day}
                  fileName={`sales-${range.from}-${range.to}`}
                />
              </Panel>
            );
          case 'channels':
            return (
              <Panel key={section} title={heading}>
                <DataTable columns={channelColumns} rows={parts.channels} rowKey={(row) => row.key} fileName={`channels-${range.from}-${range.to}`} />
              </Panel>
            );
          case 'governorates':
            return (
              <Panel key={section} title={heading}>
                <DataTable columns={areaColumns} rows={parts.governorates} rowKey={(row) => row.key} fileName={`governorates-${range.from}-${range.to}`} />
              </Panel>
            );
        }
      })}
    </div>
  );
}
