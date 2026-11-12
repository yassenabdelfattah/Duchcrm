import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Camera, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { cairoDate, formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { pieceCost, sheetFor } from '../../lib/profitMath';
import { compareRuns, previousRun, runCost, type ProductionRun, type RunLine } from '../../lib/productionMath';
import { useLocale } from '../../i18n';
import { Button, ErrorNote, Field, Input, Modal, cx, toast } from '../../components/ui';
import { Panel } from './parts';
import type { ProfitBooks } from './data';

/**
 * The manufacturing log (the owner, 2026-11-12): one entry for the products
 * made together - black and ash grey cuffed sweatpants off one order of
 * fabric - with what making them cost, the receipts as photos, and how it
 * compares with the last time the same thing was made.
 *
 * Saving an entry changes no product's cost. Making it their cost is its own
 * step, which shows old against new for each product and waits for a yes.
 * Nothing here touches a selling price or stock.
 */

const BUCKET = 'receipts';

const amountOf = (text: string) => {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && text.trim() !== '' ? value : null;
};

export function ProductionLog({ books, onChanged }: { books: ProfitBooks; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState<ProductionRun | 'new' | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = useMemo(() => new Map(books.products.map((product) => [product.id, product.title])), [books]);
  const money = (value: number) => formatEGP(value, locale);
  const runToApply = applying ? books.runs.find((run) => run.id === applying) : null;

  async function remove(run: ProductionRun) {
    if (!window.confirm(t('production.confirmDelete', { name: run.name }))) return;
    setError(null);
    // The photos first: once the entry is gone nothing says where they are.
    if (run.receipts.length > 0) await supabase.storage.from(BUCKET).remove(run.receipts.map((receipt) => receipt.path));
    const { error: failed } = await supabase.from('production_runs').delete().eq('id', run.id);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.costs.deleted'));
    onChanged();
  }

  return (
    <Panel
      title={t('production.title')}
      help={t('production.help')}
      action={
        <Button className="min-h-10 text-xs" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('production.add')}
        </Button>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {books.runs.length === 0 ? <p className="text-sm text-stone-500">{t('production.none')}</p> : null}

      <ul className="space-y-3">
        {books.runs.map((run) => {
          const cost = runCost(run);
          const before = previousRun(books.runs, run);
          const change = before ? compareRuns(cost, runCost(before)) : null;
          const pending = run.products.filter((product) => !product.applied_sheet_id).length;
          const isOpen = open === run.id;
          return (
            <li key={run.id} className="rounded-xl border border-duch-line">
              <button type="button" onClick={() => setOpen(isOpen ? null : run.id)} aria-expanded={isOpen} className="flex w-full items-start gap-3 p-3 text-start hover:bg-stone-50">
                <span className="min-w-0 flex-1">
                  <bdi className="block text-sm font-bold">{run.name}</bdi>
                  <span className="block text-xs text-stone-500">
                    <span className="tabular">{formatDate(run.made_on, locale)}</span>
                    {' · '}
                    {t('production.productsCount', { count: run.products.length })}
                    {cost.pieces > 0 ? ` · ${t('analytics.pieces', { count: cost.pieces })}` : ''}
                    {run.receipts.length > 0 ? ` · ${t('production.receiptsCount', { count: run.receipts.length })}` : ''}
                  </span>
                  {pending > 0 ? (
                    <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">{t('production.notApplied', { count: pending })}</span>
                  ) : (
                    <span className="mt-1 inline-block rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">{t('production.applied')}</span>
                  )}
                </span>
                <span className="shrink-0 text-end">
                  <span className="tabular block text-sm font-extrabold">{cost.perPiece === null ? '—' : money(cost.perPiece)}</span>
                  <span className="block text-xs text-stone-500">{t('production.perPiece')}</span>
                  {change && change.change !== null ? <Delta value={change.change} money={money} /> : null}
                </span>
              </button>

              {isOpen ? (
                <div className="space-y-4 border-t border-duch-line p-3">
                  {run.note ? <bdi className="block text-sm text-stone-600">{run.note}</bdi> : null}

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-duch-line text-xs text-stone-500">
                          <th className="py-1.5 text-start font-bold">{t('production.line')}</th>
                          <th className="hidden py-1.5 ps-3 text-end font-bold sm:table-cell">{t('production.paid')}</th>
                          <th className="py-1.5 ps-3 text-end font-bold">{t('production.perPiece')}</th>
                          {before ? <th className="py-1.5 ps-3 text-end font-bold">{t('production.lastTime')}</th> : null}
                          {before ? <th className="py-1.5 ps-3 text-end font-bold">{t('production.difference')}</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {(change?.lines ?? cost.lines.map((line) => ({ label: line.label, before: null, now: line.perPiece, change: null }))).map((line) => {
                          const own = cost.lines.find((row) => row.label === line.label);
                          return (
                            <tr key={line.label} className={cx('border-b border-stone-100', line.now === null && 'text-stone-400')}>
                              <td className="py-1.5">
                                <bdi>{line.label}</bdi>
                              </td>
                              <td className="tabular hidden whitespace-nowrap py-1.5 ps-3 text-end text-stone-500 sm:table-cell">{own?.basis === 'total' ? money(own.amount) : ''}</td>
                              <td className="tabular whitespace-nowrap py-1.5 ps-3 text-end font-semibold">{line.now === null ? '—' : money(line.now)}</td>
                              {before ? <td className="tabular whitespace-nowrap py-1.5 ps-3 text-end text-stone-500">{line.before === null ? '—' : money(line.before)}</td> : null}
                              {before ? (
                                <td className="whitespace-nowrap py-1.5 ps-3 text-end">
                                  {line.change === null ? <span className="text-xs text-stone-400">{t(line.now === null ? 'production.gone' : 'production.new')}</span> : <Delta value={line.change} money={money} />}
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="font-extrabold">
                          <td className="py-1.5">{t('production.pieceCost')}</td>
                          <td className="tabular hidden whitespace-nowrap py-1.5 ps-3 text-end sm:table-cell">{money(cost.total)}</td>
                          <td className="tabular py-1.5 ps-3 text-end">{cost.perPiece === null ? '—' : money(cost.perPiece)}</td>
                          {before ? <td className="tabular py-1.5 ps-3 text-end">{runCost(before).perPiece === null ? '—' : money(runCost(before).perPiece ?? 0)}</td> : null}
                          {before ? <td className="py-1.5 ps-3 text-end">{change && change.change !== null ? <Delta value={change.change} money={money} /> : null}</td> : null}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="text-sm">
                    {t('production.totalPaid')}: <span className="tabular font-bold">{money(cost.total)}</span>
                  </p>
                  {before ? (
                    <p className="text-xs text-stone-500">{t('production.comparedWith', { name: before.name, date: formatDate(before.made_on, locale) })}</p>
                  ) : (
                    <p className="text-xs text-stone-500">{t('production.firstRun')}</p>
                  )}

                  <div>
                    <p className="mb-1 text-xs font-bold text-stone-500">{t('production.products')}</p>
                    <ul className="space-y-1 text-sm">
                      {run.products.map((product) => (
                        <li key={product.product_id} className="flex items-baseline justify-between gap-3">
                          <bdi className="min-w-0">{title.get(product.product_id) ?? '—'}</bdi>
                          <span className="shrink-0 text-xs text-stone-500">
                            {product.pieces > 0 ? `${t('analytics.pieces', { count: product.pieces })} · ` : ''}
                            {t(product.applied_sheet_id ? 'production.productApplied' : 'production.productNotApplied')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <Receipts run={run} onChanged={onChanged} />

                  <div className="flex flex-wrap gap-2">
                    <Button className="min-h-10 text-xs" disabled={cost.perPiece === null} onClick={() => setApplying(run.id)}>
                      {t('production.apply')}
                    </Button>
                    <Button variant="secondary" className="min-h-10 text-xs" onClick={() => setEditing(run)}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      {t('production.edit')}
                    </Button>
                    <Button variant="ghost" className="ms-auto min-h-10 text-xs text-stone-500 hover:text-red-700" onClick={() => void remove(run)}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t('profit.delete')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {editing ? (
        <RunEditor
          key={editing === 'new' ? 'new' : editing.id}
          run={editing === 'new' ? null : editing}
          books={books}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            const fresh = editing === 'new';
            setEditing(null);
            setOpen(id);
            onChanged();
            // Straight on to the question the owner asked for: make it their cost?
            if (fresh) setApplying(id);
          }}
        />
      ) : null}
      {runToApply ? (
        <ApplyRun
          key={runToApply.id}
          run={runToApply}
          books={books}
          onClose={() => setApplying(null)}
          onApplied={() => {
            setApplying(null);
            onChanged();
          }}
        />
      ) : null}
    </Panel>
  );
}

/** Up is dearer, so it is the red one. */
function Delta({ value, money }: { value: number; money: (value: number) => string }) {
  const { t } = useLocale();
  if (value === 0) return <span className="block text-xs text-stone-400">{t('production.same')}</span>;
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-xs font-semibold', value > 0 ? 'text-red-700' : 'text-emerald-700')}>
      {value > 0 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />}
      <span className="tabular">{money(Math.abs(value))}</span>
    </span>
  );
}

// --- Receipts --------------------------------------------------------------------------------------

function Receipts({ run, onChanged }: { run: ProductionRun; onChanged: () => void }) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paths = run.receipts.map((receipt) => receipt.path).join('|');

  // The bucket is private: each photo is shown through a link that lasts an hour.
  useEffect(() => {
    let cancelled = false;
    if (!paths) return;
    void supabase.storage
      .from(BUCKET)
      .createSignedUrls(paths.split('|'), 3600)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const next: Record<string, string> = {};
        for (const row of data) if (row.path && row.signedUrl) next[row.path] = row.signedUrl;
        setLinks(next);
      });
    return () => {
      cancelled = true;
    };
  }, [paths]);

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    for (const file of Array.from(files)) {
      const extension = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${run.id}/${crypto.randomUUID()}.${extension}`;
      const { error: failed } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
      if (failed) {
        setError(t('production.uploadFailed', { name: file.name }));
        continue;
      }
      const { error: rowFailed } = await supabase.from('production_run_receipts').insert({ run_id: run.id, path, file_name: file.name });
      if (rowFailed) {
        await supabase.storage.from(BUCKET).remove([path]);
        setError(arabicError(rowFailed));
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    onChanged();
  }

  async function remove(receipt: ProductionRun['receipts'][number]) {
    if (!window.confirm(t('production.confirmDeleteReceipt'))) return;
    await supabase.storage.from(BUCKET).remove([receipt.path]);
    const { error: failed } = await supabase.from('production_run_receipts').delete().eq('id', receipt.id);
    if (failed) setError(arabicError(failed));
    onChanged();
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-bold text-stone-500">{t('production.receipts')}</p>
      <div className="flex flex-wrap gap-2">
        {run.receipts.map((receipt) => {
          const link = links[receipt.path];
          const isPdf = receipt.path.endsWith('.pdf');
          return (
            <div key={receipt.id} className="relative">
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border border-duch-line bg-stone-50"
                aria-label={receipt.file_name ?? t('production.receipt')}
              >
                {isPdf || !link ? <FileText className="h-6 w-6 text-stone-400" aria-hidden /> : <img src={link} alt="" className="h-full w-full object-cover" loading="lazy" />}
              </a>
              <button
                type="button"
                onClick={() => void remove(receipt)}
                aria-label={t('production.deleteReceipt')}
                className="absolute -end-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-duch-line bg-white text-stone-500 shadow-sm hover:text-red-700"
              >
                <Trash2 className="h-3 w-3" aria-hidden />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-stone-300 text-xs font-semibold text-stone-500 hover:bg-stone-50 disabled:opacity-50"
        >
          <Camera className="h-5 w-5" aria-hidden />
          {t(busy ? 'production.uploading' : 'production.addReceipt')}
        </button>
        <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={(event) => void add(event.target.files)} />
      </div>
      {error ? <p className="mt-1.5 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

// --- Writing an entry --------------------------------------------------------------------------------

interface DraftLine {
  label: string;
  basis: RunLine['basis'];
  amount: string;
}

function RunEditor({ run, books, onClose, onSaved }: { run: ProductionRun | null; books: ProfitBooks; onClose: () => void; onSaved: (id: string) => void }) {
  const { t, locale } = useLocale();
  // The id is made here, so a second tap on save writes the same entry again
  // rather than a second one.
  const [id] = useState(() => run?.id ?? crypto.randomUUID());
  const [name, setName] = useState(run?.name ?? '');
  const [madeOn, setMadeOn] = useState(run?.made_on ?? cairoDate());
  const [note, setNote] = useState(run?.note ?? '');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Map<string, string>>(
    () => new Map(run?.products.map((product) => [product.product_id, product.pieces > 0 ? String(product.pieces) : '']) ?? []),
  );
  const [lines, setLines] = useState<DraftLine[]>(() =>
    run
      ? run.lines.map((line) => ({ label: line.label, basis: line.basis, amount: String(line.amount_egp) }))
      : (['fabric', 'tailoring', 'accessories', 'printing', 'packaging'] as const).map((key) => ({ label: t(`profit.costs.default.${key}`), basis: 'per_piece', amount: '' })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const products = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return books.products
      .filter((product) => product.status !== 'archived' || picked.has(product.id))
      .filter((product) => picked.has(product.id) || !needle || product.title.toLowerCase().includes(needle))
      // The ones in the run first, so the list reads as the run.
      .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)) || a.title.localeCompare(b.title));
  }, [books, search, picked]);

  const filled = lines.filter((line) => line.label.trim() !== '' && amountOf(line.amount) !== null);
  const cost = runCost({
    products: [...picked.entries()].map(([product_id, pieces]) => ({ product_id, pieces: Number(pieces) || 0, applied_sheet_id: null })),
    lines: filled.map((line) => ({ label: line.label, basis: line.basis, amount_egp: amountOf(line.amount) ?? 0 })),
  });

  const update = (index: number, change: Partial<DraftLine>) => setLines((list) => list.map((line, at) => (at === index ? { ...line, ...change } : line)));

  async function save() {
    if (!name.trim()) return setError(t('production.needName'));
    if (picked.size === 0) return setError(t('production.needProducts'));
    if (filled.length === 0) return setError(t('profit.costs.needLine'));
    if (filled.some((line) => (amountOf(line.amount) ?? -1) < 0)) return setError(t('profit.needAmount'));
    if (cost.perPiece === null) return setError(t('production.needPieces'));
    setSaving(true);
    setError(null);
    const { error: failed } = await supabase.rpc('save_production_run', {
      p_id: id,
      p_made_on: madeOn,
      p_name: name.trim(),
      p_note: note.trim() || null,
      p_products: [...picked.entries()].map(([product_id, pieces]) => ({ product_id, pieces: Math.max(0, Math.floor(Number(pieces) || 0)) })),
      p_lines: filled.map((line) => ({ label: line.label.trim(), basis: line.basis, amount_egp: amountOf(line.amount) })),
    });
    setSaving(false);
    if (failed) return setError(arabicError(failed));
    toast(t('profit.saved'));
    onSaved(id);
  }

  return (
    <Modal open title={t(run ? 'production.edit' : 'production.add')} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('production.name')} hint={t('production.nameHint')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('production.namePlaceholder')} />
        </Field>
        <Field label={t('production.madeOn')}>
          <Input type="date" value={madeOn} onChange={(event) => event.target.value && setMadeOn(event.target.value)} className="tabular" />
        </Field>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-stone-600">{t('production.pickProducts')}</p>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('profit.costs.search')} className="min-h-10" />
          <ul className="max-h-56 divide-y divide-stone-100 overflow-y-auto rounded-lg border border-duch-line">
            {products.map((product) => {
              const on = picked.has(product.id);
              return (
                <li key={product.id} className="flex items-center gap-2 px-2.5 py-1.5">
                  <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Map(current);
                          if (on) next.delete(product.id);
                          else next.set(product.id, '');
                          return next;
                        })
                      }
                      className="h-4 w-4 shrink-0"
                    />
                    <bdi className="truncate text-sm">{product.title}</bdi>
                  </label>
                  {on ? (
                    <div className="w-24 shrink-0">
                      <Input
                        value={picked.get(product.id) ?? ''}
                        onChange={(event) => setPicked((current) => new Map(current).set(product.id, event.target.value))}
                        inputMode="numeric"
                        placeholder={t('production.piecesPlaceholder')}
                        aria-label={t('production.piecesOf', { name: product.title })}
                        className="tabular min-h-10 text-end"
                        dir="ltr"
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-stone-500">{t('production.piecesHelp')}</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-stone-600">{t('production.costLines')}</p>
          {lines.map((line, index) => (
            <div key={index} className="space-y-2 rounded-lg border border-duch-line p-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Input value={line.label} onChange={(event) => update(index, { label: event.target.value })} placeholder={t('profit.costs.linePlaceholder')} aria-label={t('profit.costs.lineName')} className="min-h-10" />
                </div>
                <div className="w-28 shrink-0">
                  <Input
                    value={line.amount}
                    onChange={(event) => update(index, { amount: event.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={t('profit.costs.amount')}
                    className="tabular min-h-10 text-end"
                    dir="ltr"
                  />
                </div>
                <Button variant="ghost" className="min-h-10 px-2 text-stone-400 hover:text-red-700" aria-label={t('profit.costs.removeLine')} onClick={() => setLines((list) => list.filter((_, at) => at !== index))}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              {/* What the figure is: for each piece, or the whole bill. */}
              <div className="flex gap-1.5">
                {(['per_piece', 'total'] as const).map((basis) => (
                  <button
                    key={basis}
                    type="button"
                    onClick={() => update(index, { basis })}
                    aria-pressed={line.basis === basis}
                    className={cx(
                      'min-h-8 rounded-full px-3 text-xs font-semibold',
                      line.basis === basis ? 'bg-duch-ink text-white' : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                    )}
                  >
                    {t(`production.basis.${basis}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <Button variant="secondary" className="min-h-9 text-xs" onClick={() => setLines((list) => [...list, { label: '', basis: 'per_piece', amount: '' }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('profit.costs.addLine')}
          </Button>
        </div>

        <dl className="space-y-1 rounded-lg bg-stone-50 p-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-stone-500">{t('production.totalPieces')}</dt>
            <dd className="tabular">{cost.pieces}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-stone-500">{t('production.totalPaid')}</dt>
            <dd className="tabular">{formatEGP(cost.total, locale)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 font-extrabold">
            <dt>{t('production.pieceCost')}</dt>
            <dd className="tabular">{cost.perPiece === null ? '—' : formatEGP(cost.perPiece, locale)}</dd>
          </div>
        </dl>

        <Field label={t('profit.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('production.notePlaceholder')} />
        </Field>

        <p className="text-xs text-stone-500">{t(run ? 'production.editHelp' : 'production.saveHelp')}</p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" disabled={saving} onClick={() => void save()}>
          {t('production.save')}
        </Button>
      </div>
    </Modal>
  );
}

// --- Making it the products' cost ---------------------------------------------------------------------

/**
 * Old against new for each product, and nothing changes until the owner says
 * so (his choice: ask each time). What a product sets aside - against courier
 * losses, for the gift fund - is not part of making it and is kept as it is.
 */
function ApplyRun({ run, books, onClose, onApplied }: { run: ProductionRun; books: ProfitBooks; onClose: () => void; onApplied: () => void }) {
  const { t, locale } = useLocale();
  const money = (value: number) => formatEGP(value, locale);
  const cost = runCost(run);
  const today = cairoDate();
  const [from, setFrom] = useState(run.made_on > today ? today : run.made_on);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(run.products.map((product) => product.product_id)));
  // What each piece sets aside. Empty leaves every product's own as it is.
  const [loss, setLoss] = useState('');
  const [gift, setGift] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lossValue = amountOf(loss);
  const giftValue = amountOf(gift);

  const rows = run.products.map((product) => {
    const info = books.products.find((row) => row.id === product.product_id);
    const sheet = sheetFor(books.sheets.get(product.product_id), from);
    const current = sheet ? pieceCost(sheet, null, null) : null;
    return {
      id: product.product_id,
      title: info?.title ?? '—',
      current: current?.cost ?? null,
      loss: current?.lossReserve ?? 0,
      gift: current?.giftReserve ?? 0,
      // A size or colour that costs more is typed on the product, and a run's cost is one figure for all.
      differs: Boolean(sheet?.lines.some((line) => line.kind === 'cost' && line.overrides.length > 0)),
    };
  });

  async function apply() {
    if (picked.size === 0) return setError(t('production.pickToApply'));
    if ((loss.trim() !== '' && (lossValue === null || lossValue < 0)) || (gift.trim() !== '' && (giftValue === null || giftValue < 0))) return setError(t('profit.needAmount'));
    setSaving(true);
    setError(null);
    const { error: failed } = await supabase.rpc('apply_production_run', {
      p_run_id: run.id,
      p_product_ids: [...picked],
      p_effective_from: from,
      // Sent only when typed: left out, each product keeps what it sets aside.
      ...(lossValue !== null ? { p_loss_reserve: lossValue } : {}),
      ...(giftValue !== null ? { p_gift_reserve: giftValue } : {}),
    });
    setSaving(false);
    if (failed) return setError(arabicError(failed));
    toast(t('production.appliedToast', { count: picked.size }));
    onApplied();
  }

  return (
    <Modal open title={t('production.applyTitle')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">{t('production.applyBody', { name: run.name, amount: cost.perPiece === null ? '—' : money(cost.perPiece) })}</p>

        <ul className="space-y-2">
          {rows.map((row) => {
            const change = row.current !== null && cost.perPiece !== null ? cost.perPiece - row.current : null;
            return (
              <li key={row.id} className="rounded-lg border border-duch-line p-2.5">
                <label className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={picked.has(row.id)}
                    onChange={() =>
                      setPicked((current) => {
                        const next = new Set(current);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <bdi className="block text-sm font-semibold">{row.title}</bdi>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
                      <span>
                        {t('production.now')} <span className="tabular font-semibold text-duch-ink">{row.current === null ? t('profit.noCost') : money(row.current)}</span>
                      </span>
                      <span aria-hidden>←</span>
                      <span>
                        {t('production.becomes')} <span className="tabular font-semibold text-duch-ink">{cost.perPiece === null ? '—' : money(cost.perPiece)}</span>
                      </span>
                      {change !== null ? <Delta value={Math.round(change * 100) / 100} money={money} /> : null}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {t('production.setsAside', { loss: money(lossValue ?? row.loss), gift: money(giftValue ?? row.gift) })}
                    </span>
                    {row.differs ? <span className="block text-xs text-amber-800">{t('production.differsWarning')}</span> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-2.5">
          <p className="text-xs font-semibold text-amber-900">{t('production.reservesTitle')}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('profit.costs.default.lossReserve')}>
              <Input value={loss} onChange={(event) => setLoss(event.target.value)} inputMode="decimal" placeholder={t('production.asIs')} className="tabular min-h-10" />
            </Field>
            <Field label={t('profit.costs.default.giftReserve')}>
              <Input value={gift} onChange={(event) => setGift(event.target.value)} inputMode="decimal" placeholder={t('production.asIs')} className="tabular min-h-10" />
            </Field>
          </div>
          <p className="text-xs text-amber-800">{t('production.reservesHelp')}</p>
        </div>

        <Field label={t('production.from')} hint={t('production.fromHelp')}>
          <Input type="date" value={from} onChange={(event) => event.target.value && setFrom(event.target.value)} className="tabular" />
        </Field>

        <p className="text-xs text-stone-500">{t('production.priceUntouched')}</p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={saving || cost.perPiece === null} onClick={() => void apply()}>
            {t('production.applyConfirm')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('production.notNow')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
