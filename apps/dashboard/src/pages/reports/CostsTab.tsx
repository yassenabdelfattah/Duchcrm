import { useMemo, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { cairoDate, compareVariants, formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { addDays, within, type Range } from '../../lib/reportMath';
import { addMonths, adShare, monthRange, pieceCost, sheetFor, type ExpenseRow } from '../../lib/profitMath';
import { useLocale } from '../../i18n';
import { Button, ErrorNote, Field, Input, Modal, Select, cx, toast } from '../../components/ui';
import { Panel, Segmented } from './parts';
import { CostEditor } from './CostEditor';
import { FundLines } from './ProfitTab';
import type { CostProduct, ProfitBooks } from './data';
import type { ProfitModel } from './model';

/**
 * Everything typed in about money, in one place: what each product costs to
 * make, the ads, the expenses of the month, and the gift fund. Nothing here
 * is worked out - these are the figures the profit is worked out from.
 */

export type CostsView = 'products' | 'ads' | 'expenses' | 'gift';

const amountOf = (text: string) => {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && text.trim() !== '' ? value : null;
};

export function CostsTab({
  model,
  view,
  onView,
  onChanged,
}: {
  model: ProfitModel;
  view: CostsView;
  onView: (view: CostsView) => void;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="space-y-4">
      <Segmented
        value={view}
        onChange={onView}
        options={(['products', 'ads', 'expenses', 'gift'] as const).map((value) => ({ value, label: t(`profit.costs.view.${value}`) }))}
      />
      {view === 'products' ? <ProductCosts books={model.books} onChanged={onChanged} /> : null}
      {view === 'ads' ? <AdSpend key={`${model.range.from}:${model.range.to}`} books={model.books} range={model.range} onChanged={onChanged} /> : null}
      {view === 'expenses' ? <Expenses books={model.books} range={model.range} onChanged={onChanged} /> : null}
      {view === 'gift' ? <GiftFundPanel model={model} onChanged={onChanged} /> : null}
    </div>
  );
}

// --- What each product costs ----------------------------------------------------------------------

function ProductCosts({ books, onChanged }: { books: ProfitBooks; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const today = cairoDate();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CostProduct | null>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return books.products
      .filter((product) => product.status !== 'archived' || books.sheets.has(product.id))
      .filter((product) => !needle || product.title.toLowerCase().includes(needle))
      .map((product) => {
        const sheet = sheetFor(books.sheets.get(product.id), today);
        const each = sheet ? pieceCost(sheet, null, null) : null;
        const prices = product.variants.filter((variant) => variant.is_active && Number(variant.price_egp) > 0).map((variant) => Number(variant.price_egp));
        return { product, sheet, each, price: prices.length > 0 ? Math.min(...prices) : null };
      })
      // What still needs a cost first.
      .sort((a, b) => Number(Boolean(a.sheet)) - Number(Boolean(b.sheet)) || a.product.title.localeCompare(b.product.title));
  }, [books, search, today]);
  const missing = rows.filter((row) => !row.sheet).length;

  return (
    <Panel
      title={t('profit.costs.productsTitle')}
      help={missing > 0 ? t('profit.costs.productsMissing', { count: missing }) : t('profit.costs.productsHelp')}
    >
      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('profit.costs.search')} className="min-h-10" />
      <ul className="divide-y divide-stone-100">
        {rows.map(({ product, sheet, each, price }) => (
          <li key={product.id}>
            <button type="button" onClick={() => setEditing(product)} className="flex w-full items-center gap-3 py-2.5 text-start hover:bg-stone-50">
              {product.image_url ? (
                <img src={product.image_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" />
              ) : (
                <span className="h-10 w-10 shrink-0 rounded-lg bg-stone-100" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <bdi className="block truncate text-sm font-semibold">{product.title}</bdi>
                <span className="block text-xs text-stone-500">
                  {price !== null ? t('profit.costs.sellsFor', { price: formatEGP(price, locale) }) : t('profit.costs.noPrice')}
                  {sheet && sheet.lines.some((line) => line.overrides.length > 0) ? ` · ${t('profit.costs.differs')}` : ''}
                </span>
              </span>
              {each ? (
                <span className="shrink-0 text-end">
                  <span className="tabular block text-sm font-bold">
                    {formatEGP(each.cost, locale)}
                  </span>
                  {price !== null ? (
                    <span className={cx('tabular block text-xs', price - each.cost - each.lossReserve - each.giftReserve < 0 ? 'text-red-700' : 'text-emerald-700')}>
                      {formatEGP(price - each.cost - each.lossReserve - each.giftReserve, locale)}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">{t('profit.noCost')}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {rows.length === 0 ? <p className="text-sm text-stone-500">{t('analytics.empty')}</p> : null}
      <p className="text-xs text-stone-500">{t('profit.costs.listLegend')}</p>

      {editing ? (
        <CostEditor
          key={editing.id}
          product={editing}
          sheets={books.sheets.get(editing.id) ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
    </Panel>
  );
}

// --- Ads -------------------------------------------------------------------------------------------

function AdSpend({ books, range, onChanged }: { books: ProfitBooks; range: Range; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inRange = books.ads.filter((row) => adShare(row, range) > 0);
  const total = inRange.reduce((sum, row) => sum + adShare(row, range), 0);

  async function add() {
    const value = amountOf(amount);
    if (value === null || value <= 0) {
      setError(t('profit.needAmount'));
      return;
    }
    if (to < from) {
      setError(t('profit.ads.badDates'));
      return;
    }
    setSaving(true);
    setError(null);
    const { error: failed } = await supabase.from('ad_spend').insert({ platform: 'meta', from_date: from, to_date: to, amount_egp: value, note: note.trim() || null });
    setSaving(false);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    setAmount('');
    setNote('');
    toast(t('profit.saved'));
    onChanged();
  }

  async function remove(id: string) {
    if (!window.confirm(t('profit.confirmDelete'))) return;
    const { error: failed } = await supabase.from('ad_spend').delete().eq('id', id);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    onChanged();
  }

  return (
    <div className="space-y-4">
      <Panel title={t('profit.ads.addTitle')} help={t('profit.ads.addHelp')}>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('profit.amount')}>
            <Input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0" className="tabular" dir="ltr" />
          </Field>
          <Field label={t('analytics.from')}>
            <Input type="date" value={from} onChange={(event) => event.target.value && setFrom(event.target.value)} className="tabular" />
          </Field>
          <Field label={t('analytics.to')}>
            <Input type="date" value={to} min={from} onChange={(event) => event.target.value && setTo(event.target.value)} className="tabular" />
          </Field>
          <Field label={t('profit.note')}>
            <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('profit.ads.notePlaceholder')} />
          </Field>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button disabled={saving} onClick={() => void add()}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('profit.ads.add')}
        </Button>
      </Panel>

      <Panel title={t('profit.ads.listTitle')} help={t('profit.ads.listHelp', { amount: formatEGP(total, locale) })}>
        {books.ads.length === 0 ? (
          <p className="text-sm text-stone-500">{t('profit.noAds')}</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {books.ads.map((row) => {
              const share = adShare(row, range);
              return (
                <li key={row.id} className={cx('flex items-center gap-3 py-2 text-sm', share === 0 && 'opacity-50')}>
                  <span className="min-w-0 flex-1">
                    <span className="tabular block">
                      {formatDate(row.from_date, locale)} – {formatDate(row.to_date, locale)}
                    </span>
                    {row.note ? <bdi className="block text-xs text-stone-500">{row.note}</bdi> : null}
                  </span>
                  <span className="shrink-0 text-end">
                    <span className="tabular block font-bold">
                      {formatEGP(Number(row.amount_egp), locale)}
                    </span>
                    {share > 0 && share !== Number(row.amount_egp) ? (
                      <span className="block text-xs text-stone-500">{t('profit.ads.inPeriod', { amount: formatEGP(share, locale) })}</span>
                    ) : null}
                  </span>
                  <Button variant="ghost" className="min-h-9 px-2 text-stone-400 hover:text-red-700" aria-label={t('profit.delete')} onClick={() => void remove(row.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// --- Expenses ---------------------------------------------------------------------------------------

/** One form for money going out: a fixed cost off profit, or something bought from the gift fund. */
export function ExpenseForm({
  kind,
  day,
  suggestions,
  onSaved,
}: {
  kind: 'expense' | 'gift';
  day: string;
  suggestions: string[];
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(day);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = `expense-suggestions-${kind}`;

  async function add() {
    const value = amountOf(amount);
    if (!category.trim()) {
      setError(t('profit.expenses.needCategory'));
      return;
    }
    if (value === null || value <= 0) {
      setError(t('profit.needAmount'));
      return;
    }
    setSaving(true);
    setError(null);
    const { error: failed } = await supabase
      .from('expenses')
      .insert({ kind, spent_on: spentOn, category: category.trim(), amount_egp: value, note: note.trim() || null });
    setSaving(false);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    setCategory('');
    setAmount('');
    setNote('');
    toast(t('profit.saved'));
    onSaved();
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t(kind === 'gift' ? 'profit.gift.what' : 'profit.expenses.category')}>
          <Input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            list={listId}
            placeholder={t(kind === 'gift' ? 'profit.gift.whatPlaceholder' : 'profit.expenses.categoryPlaceholder')}
          />
          <datalist id={listId}>
            {suggestions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </Field>
        <Field label={t('profit.amount')}>
          <Input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0" className="tabular" dir="ltr" />
        </Field>
        <Field label={t('profit.date')}>
          <Input type="date" value={spentOn} onChange={(event) => event.target.value && setSpentOn(event.target.value)} className="tabular" />
        </Field>
        <Field label={t('profit.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button disabled={saving} onClick={() => void add()}>
        <Plus className="h-4 w-4" aria-hidden />
        {t(kind === 'gift' ? 'profit.gift.add' : 'profit.expenses.add')}
      </Button>
    </div>
  );
}

function ExpenseList({ rows, onChanged }: { rows: ExpenseRow[]; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const [error, setError] = useState<string | null>(null);

  async function remove(row: ExpenseRow) {
    if (!window.confirm(t(row.stock_out_id ? 'profit.gift.confirmDeleteStock' : 'profit.confirmDelete'))) return;
    const { error: failed } = await supabase.from('expenses').delete().eq('id', row.id);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    onChanged();
  }

  if (rows.length === 0) return <p className="text-sm text-stone-500">{t('profit.expenses.none')}</p>;
  return (
    <>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <ul className="divide-y divide-stone-100">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <bdi className="block font-semibold">{row.category}</bdi>
              <span className="block text-xs text-stone-500">
                <span className="tabular">{formatDate(row.spent_on, locale)}</span>
                {row.note ? (
                  <>
                    {' · '}
                    <bdi>{row.note}</bdi>
                  </>
                ) : null}
              </span>
            </span>
            <span className="tabular shrink-0 font-bold">
              {formatEGP(Number(row.amount_egp), locale)}
            </span>
            <Button variant="ghost" className="min-h-9 px-2 text-stone-400 hover:text-red-700" aria-label={t('profit.delete')} onClick={() => void remove(row)}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Expenses({ books, range, onChanged }: { books: ProfitBooks; range: Range; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const today = cairoDate();
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fixed = books.expenses.filter((row) => row.kind === 'expense');
  const rows = fixed.filter((row) => within(row.spent_on, range));
  const total = rows.reduce((sum, row) => sum + Number(row.amount_egp), 0);
  // What was typed before, offered again: rent is rent every month.
  const suggestions = useMemo(
    () => [...new Set([...fixed.map((row) => row.category.trim()), ...(['rent', 'salaries', 'utilities', 'shoot', 'subscriptions'] as const).map((key) => t(`profit.expenses.default.${key}`))])],
    [fixed, t],
  );

  // The month before the range's, to bring its fixed costs forward.
  const month = range.from.slice(0, 7);
  const previous = monthRange(addMonths(month, -1), today);
  const lastMonth = fixed.filter((row) => within(row.spent_on, previous));

  async function copyLastMonth() {
    if (!window.confirm(t('profit.expenses.confirmCopy', { count: lastMonth.length }))) return;
    setCopying(true);
    setError(null);
    const { error: failed } = await supabase.from('expenses').insert(
      lastMonth.map((row) => ({
        kind: 'expense',
        // The same day of this month, or its last day when the month is shorter.
        spent_on: [`${month}-${row.spent_on.slice(8)}`, addDays(`${addMonths(month, 1)}-01`, -1)].sort()[0]!,
        category: row.category,
        amount_egp: row.amount_egp,
        note: row.note,
      })),
    );
    setCopying(false);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.saved'));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <Panel title={t('profit.expenses.addTitle')} help={t('profit.expenses.addHelp')}>
        <ExpenseForm key={range.to} kind="expense" day={within(today, range) ? today : range.to} suggestions={suggestions} onSaved={onChanged} />
      </Panel>
      <Panel
        title={t('profit.expenses.listTitle')}
        help={t('profit.expenses.listHelp', { amount: formatEGP(total, locale) })}
        action={
          rows.length === 0 && lastMonth.length > 0 ? (
            <Button variant="secondary" className="min-h-9 text-xs" disabled={copying} onClick={() => void copyLastMonth()}>
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {t('profit.expenses.copyLast')}
            </Button>
          ) : null
        }
      >
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <ExpenseList rows={rows} onChanged={onChanged} />
      </Panel>
    </div>
  );
}

// --- The gift fund -----------------------------------------------------------------------------------

function GiftFundPanel({ model, onChanged }: { model: ProfitModel; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const { books, range, fund } = model;
  const today = cairoDate();
  const [fromStock, setFromStock] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const suggestions = useMemo(() => [...new Set(books.expenses.filter((row) => row.kind === 'gift' && !row.stock_out_id).map((row) => row.category.trim()))], [books]);

  return (
    <div className="space-y-4">
      <Panel
        title={t('profit.fund.title')}
        help={t('profit.fund.startedOn', { date: formatDate(books.settings.gift_fund_from, locale) })}
        action={
          <Button variant="secondary" className="min-h-9 text-xs" onClick={() => setSettingsOpen(true)}>
            {t('profit.fund.settings')}
          </Button>
        }
      >
        <FundLines fund={fund} />
      </Panel>

      <Panel title={t('profit.gift.addTitle')} help={t('profit.gift.addHelp')}>
        <ExpenseForm key={range.to} kind="gift" day={within(today, range) ? today : range.to} suggestions={suggestions} onSaved={onChanged} />
        <div className="border-t border-duch-line pt-3">
          <Button variant="secondary" onClick={() => setFromStock(true)}>
            {t('profit.gift.fromStock')}
          </Button>
          <p className="mt-1.5 text-xs text-stone-500">{t('profit.gift.fromStockHelp')}</p>
        </div>
      </Panel>

      <Panel title={t('profit.gift.listTitle')}>
        <ExpenseList rows={fund.rows} onChanged={onChanged} />
      </Panel>

      {fromStock ? (
        <GiftFromStock
          books={books}
          day={within(today, range) ? today : range.to}
          onClose={() => setFromStock(false)}
          onSaved={() => {
            setFromStock(false);
            onChanged();
          }}
        />
      ) : null}
      {settingsOpen ? (
        <FundSettings
          books={books}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function FundSettings({ books, onClose, onSaved }: { books: ProfitBooks; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const [from, setFrom] = useState(books.settings.gift_fund_from);
  const [opening, setOpening] = useState(String(books.settings.gift_fund_opening_egp));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const value = amountOf(opening);
    if (value === null) {
      setError(t('profit.needAmount'));
      return;
    }
    const { error: failed } = await supabase.from('profit_settings').update({ gift_fund_from: from, gift_fund_opening_egp: value }).eq('id', true);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.saved'));
    onSaved();
  }

  return (
    <Modal open title={t('profit.fund.settings')} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('profit.fund.from')} hint={t('profit.fund.fromHelp')}>
          <Input type="date" value={from} onChange={(event) => event.target.value && setFrom(event.target.value)} className="tabular" />
        </Field>
        <Field label={t('profit.fund.openingLabel')} hint={t('profit.fund.openingHelp')}>
          <Input value={opening} onChange={(event) => setOpening(event.target.value)} inputMode="decimal" className="tabular" dir="ltr" />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" onClick={() => void save()}>
          {t('profit.save')}
        </Button>
      </div>
    </Modal>
  );
}

/** Dead stock given away: pick the pieces, and what the fund pays for each. */
function GiftFromStock({ books, day, onClose, onSaved }: { books: ProfitBooks; day: string; onClose: () => void; onSaved: () => void }) {
  const { t, locale } = useLocale();
  const [productId, setProductId] = useState('');
  const [items, setItems] = useState<Array<{ variant_id: string; label: string; quantity: string; price: string }>>([]);
  const [spentOn, setSpentOn] = useState(day);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key for the life of the form: a second tap takes nothing out twice.
  const [key] = useState(() => `gift-${crypto.randomUUID()}`);

  const products = books.products.filter((product) => product.status !== 'archived');
  const product = products.find((row) => row.id === productId) ?? null;
  const variants = product ? [...product.variants].filter((variant) => variant.is_active).sort(compareVariants) : [];
  const total = items.reduce((sum, item) => sum + (amountOf(item.price) ?? 0) * (Number(item.quantity) || 0), 0);

  function addVariant(variantId: string) {
    const variant = variants.find((row) => row.id === variantId);
    if (!variant || !product || items.some((item) => item.variant_id === variantId)) return;
    setItems((list) => [
      ...list,
      { variant_id: variantId, label: [product.title, variant.size, variant.color].filter(Boolean).join(' · '), quantity: '1', price: '' },
    ]);
  }

  async function save() {
    const ready = items.map((item) => ({ variant_id: item.variant_id, quantity: Number(item.quantity), unit_price_egp: amountOf(item.price) }));
    if (ready.length === 0) {
      setError(t('profit.gift.pickPieces'));
      return;
    }
    if (ready.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0 || item.unit_price_egp === null || item.unit_price_egp < 0)) {
      setError(t('profit.gift.needPrices'));
      return;
    }
    setSaving(true);
    setError(null);
    const { error: failed } = await supabase.rpc('record_gift_from_stock', { p_spent_on: spentOn, p_note: note.trim() || null, p_items: ready, p_idempotency_key: key });
    setSaving(false);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.saved'));
    onSaved();
  }

  return (
    <Modal open title={t('profit.gift.fromStock')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-stone-500">{t('profit.gift.fromStockLong')}</p>
        <Field label={t('profit.col.product')}>
          <Select value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">{t('profit.gift.pickProduct')}</option>
            {products.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </Select>
        </Field>
        {product ? (
          <div className="flex flex-wrap gap-1.5">
            {variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                onClick={() => addVariant(variant.id)}
                disabled={items.some((item) => item.variant_id === variant.id)}
                className="min-h-9 rounded-full border border-duch-line bg-white px-3 text-xs font-semibold hover:bg-stone-50 disabled:opacity-40"
              >
                <bdi>{[variant.size, variant.color].filter(Boolean).join(' / ') || variant.sku}</bdi>
              </button>
            ))}
          </div>
        ) : null}

        {items.map((item, index) => (
          <div key={item.variant_id} className="space-y-2 rounded-lg border border-duch-line p-2.5">
            <div className="flex items-center gap-2">
              <bdi className="min-w-0 flex-1 text-sm font-semibold">{item.label}</bdi>
              <Button variant="ghost" className="min-h-9 px-2 text-stone-400 hover:text-red-700" aria-label={t('profit.delete')} onClick={() => setItems((list) => list.filter((_, at) => at !== index))}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('profit.gift.quantity')}>
                <Input
                  value={item.quantity}
                  onChange={(event) => setItems((list) => list.map((row, at) => (at === index ? { ...row, quantity: event.target.value } : row)))}
                  inputMode="numeric"
                  className="tabular min-h-10"
                  dir="ltr"
                />
              </Field>
              <Field label={t('profit.gift.pricePerPiece')}>
                <Input
                  value={item.price}
                  onChange={(event) => setItems((list) => list.map((row, at) => (at === index ? { ...row, price: event.target.value } : row)))}
                  inputMode="decimal"
                  placeholder="0"
                  className="tabular min-h-10"
                  dir="ltr"
                />
              </Field>
            </div>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-2">
          <Field label={t('profit.date')}>
            <Input type="date" value={spentOn} onChange={(event) => event.target.value && setSpentOn(event.target.value)} className="tabular" />
          </Field>
          <Field label={t('profit.note')}>
            <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('profit.gift.notePlaceholder')} />
          </Field>
        </div>

        {items.length > 0 ? <p className="text-sm font-bold">{t('profit.gift.fundPays', { amount: formatEGP(total, locale) })}</p> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" disabled={saving} onClick={() => void save()}>
          {t('profit.gift.takeOut')}
        </Button>
      </div>
    </Modal>
  );
}
