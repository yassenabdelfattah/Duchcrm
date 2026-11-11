import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cairoDate, compareVariants, formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { pieceCost, type CostKind, type CostSheet } from '../../lib/profitMath';
import { useLocale } from '../../i18n';
import { Button, ErrorNote, Input, Modal, Select, cx, toast } from '../../components/ui';
import type { CostProduct } from './data';

/**
 * What one piece of a product costs, line by line.
 *
 * A new product starts with the usual lines to fill in; any can be renamed
 * or removed and more added. A line can cost something else for a size or a
 * colour. Saving either puts the current cost right (the same date), or
 * starts a new cost from a date - sales ordered before it keep the old one.
 */

interface DraftOverride {
  size: string;
  color: string;
  amount: string;
}

interface DraftLine {
  kind: CostKind;
  label: string;
  amount: string;
  overrides: DraftOverride[];
}

const amountOf = (text: string) => {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && text.trim() !== '' ? value : null;
};

export function CostEditor({
  product,
  sheets,
  onClose,
  onSaved,
}: {
  product: CostProduct;
  sheets: CostSheet[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useLocale();
  const today = cairoDate();
  const current = sheets[sheets.length - 1] ?? null;

  const [lines, setLines] = useState<DraftLine[]>(() =>
    current
      ? current.lines.map((line) => ({
          kind: line.kind,
          label: line.label,
          amount: String(line.amount_egp),
          overrides: line.overrides.map((rule) => ({ size: rule.size ?? '', color: rule.color ?? '', amount: String(rule.amount_egp) })),
        }))
      : [
          ...(['fabric', 'tailoring', 'accessories', 'printing', 'packaging'] as const).map((key) => ({
            kind: 'cost' as const,
            label: t(`profit.costs.default.${key}`),
            amount: '',
            overrides: [],
          })),
          { kind: 'loss_reserve' as const, label: t('profit.costs.default.lossReserve'), amount: '', overrides: [] },
          { kind: 'gift_reserve' as const, label: t('profit.costs.default.giftReserve'), amount: '', overrides: [] },
        ],
  );
  // With a cost already there: put it right, or start a new one from a date.
  const [mode, setMode] = useState<'fix' | 'new'>('fix');
  const [from, setFrom] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sizes = useMemo(
    () => [...new Set([...product.variants].sort(compareVariants).map((variant) => variant.size).filter((size): size is string => Boolean(size)))],
    [product],
  );
  const colors = useMemo(
    () => [...new Set(product.variants.map((variant) => variant.color).filter((color): color is string => Boolean(color)))],
    [product],
  );
  const canDiffer = sizes.length > 0 || colors.length > 0;

  const update = (index: number, change: Partial<DraftLine>) =>
    setLines((list) => list.map((line, at) => (at === index ? { ...line, ...change } : line)));
  const updateRule = (index: number, ruleIndex: number, change: Partial<DraftOverride>) =>
    update(index, { overrides: lines[index]!.overrides.map((rule, at) => (at === ruleIndex ? { ...rule, ...change } : rule)) });

  // A line left empty is simply not part of the cost.
  const filled = lines.filter((line) => line.label.trim() !== '' && amountOf(line.amount) !== null);
  const totalOf = (kind: CostKind) => filled.filter((line) => line.kind === kind).reduce((total, line) => total + (amountOf(line.amount) ?? 0), 0);
  const cost = totalOf('cost');
  const reserves = totalOf('loss_reserve') + totalOf('gift_reserve');
  const prices = product.variants.filter((variant) => variant.is_active && Number(variant.price_egp) > 0).map((variant) => Number(variant.price_egp));
  const price = prices.length > 0 ? Math.min(...prices) : null;

  async function save() {
    if (filled.length === 0) {
      setError(t('profit.costs.needLine'));
      return;
    }
    const bad = lines.find((line) => line.label.trim() !== '' && line.amount.trim() !== '' && (amountOf(line.amount) ?? -1) < 0);
    if (bad) {
      setError(t('profit.costs.badAmount', { label: bad.label }));
      return;
    }
    setSaving(true);
    setError(null);
    const { error: failed } = await supabase.rpc('save_cost_sheet', {
      p_product_id: product.id,
      p_effective_from: current && mode === 'fix' ? current.effective_from : current ? from : today,
      p_lines: filled.map((line) => ({
        kind: line.kind,
        label: line.label.trim(),
        amount_egp: amountOf(line.amount),
        overrides: line.overrides
          .filter((rule) => (rule.size || rule.color) && amountOf(rule.amount) !== null)
          .map((rule) => ({ size: rule.size || null, color: rule.color || null, amount_egp: amountOf(rule.amount) })),
      })),
    });
    setSaving(false);
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.costs.saved'));
    onSaved();
  }

  async function removeSheet(sheet: CostSheet) {
    if (!window.confirm(t('profit.costs.confirmDelete', { date: formatDate(sheet.effective_from, locale) }))) return;
    const { error: failed } = await supabase.rpc('delete_cost_sheet', { p_sheet_id: sheet.id });
    if (failed) {
      setError(arabicError(failed));
      return;
    }
    toast(t('profit.costs.deleted'));
    onSaved();
  }

  return (
    <Modal open title={product.title} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-stone-500">{t('profit.costs.editorHelp')}</p>

        <div className="space-y-3">
          {lines.map((line, index) => (
            <div key={index} className={cx('space-y-2 rounded-lg border p-2.5', line.kind === 'cost' ? 'border-duch-line' : 'border-amber-200 bg-amber-50/50')}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
<Input
                  value={line.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                  placeholder={t('profit.costs.linePlaceholder')}
                  aria-label={t('profit.costs.lineName')}
                  className="min-h-10"
                />
</div>
                <div className="w-24 shrink-0">
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
                <Button
                  variant="ghost"
                  className="min-h-10 px-2 text-stone-400 hover:text-red-700"
                  aria-label={t('profit.costs.removeLine')}
                  onClick={() => setLines((list) => list.filter((_, at) => at !== index))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              {line.kind !== 'cost' ? <p className="text-xs text-amber-800">{t(`profit.costs.kindHelp.${line.kind}`)}</p> : null}

              {line.overrides.map((rule, ruleIndex) => (
                <div key={ruleIndex} className="flex items-center gap-2 ps-3">
                  {sizes.length > 0 ? (
                    <div className="min-w-0 flex-1">
<Select
                      value={rule.size}
                      onChange={(event) => updateRule(index, ruleIndex, { size: event.target.value })}
                      aria-label={t('profit.costs.size')}
                      className="min-h-10"
                    >
                      <option value="">{t('profit.costs.anySize')}</option>
                      {sizes.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </Select>
</div>
                  ) : null}
                  {colors.length > 0 ? (
                    <div className="min-w-0 flex-1">
<Select
                      value={rule.color}
                      onChange={(event) => updateRule(index, ruleIndex, { color: event.target.value })}
                      aria-label={t('profit.costs.color')}
                      className="min-h-10"
                    >
                      <option value="">{t('profit.costs.anyColor')}</option>
                      {colors.map((color) => (
                        <option key={color} value={color}>
                          {color}
                        </option>
                      ))}
                    </Select>
</div>
                  ) : null}
                  <div className="w-24 shrink-0">
<Input
                    value={rule.amount}
                    onChange={(event) => updateRule(index, ruleIndex, { amount: event.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={t('profit.costs.amount')}
                    className="tabular min-h-10 text-end"
                    dir="ltr"
                  />
</div>
                  <Button
                    variant="ghost"
                    className="min-h-10 px-2 text-stone-400 hover:text-red-700"
                    aria-label={t('profit.costs.removeLine')}
                    onClick={() => update(index, { overrides: line.overrides.filter((_, at) => at !== ruleIndex) })}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}
              {canDiffer ? (
                <button
                  type="button"
                  className="ps-3 text-xs font-semibold text-stone-500 underline underline-offset-2 hover:text-duch-ink"
                  onClick={() => update(index, { overrides: [...line.overrides, { size: '', color: '', amount: '' }] })}
                >
                  {t('profit.costs.addException')}
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="min-h-9 text-xs" onClick={() => setLines((list) => [...list, { kind: 'cost', label: '', amount: '', overrides: [] }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('profit.costs.addLine')}
          </Button>
          {!lines.some((line) => line.kind === 'loss_reserve') ? (
            <Button
              variant="secondary"
              className="min-h-9 text-xs"
              onClick={() => setLines((list) => [...list, { kind: 'loss_reserve', label: t('profit.costs.default.lossReserve'), amount: '', overrides: [] }])}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t('profit.costs.default.lossReserve')}
            </Button>
          ) : null}
          {!lines.some((line) => line.kind === 'gift_reserve') ? (
            <Button
              variant="secondary"
              className="min-h-9 text-xs"
              onClick={() => setLines((list) => [...list, { kind: 'gift_reserve', label: t('profit.costs.default.giftReserve'), amount: '', overrides: [] }])}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t('profit.costs.default.giftReserve')}
            </Button>
          ) : null}
        </div>

        {/* What it comes to, against the price, before anything is saved. */}
        <dl className="space-y-1 rounded-lg bg-stone-50 p-3 text-sm">
          <Sum label={t('profit.costs.totalCost')} value={formatEGP(cost, locale)} strong />
          <Sum label={t('profit.costs.totalReserves')} value={formatEGP(reserves, locale)} />
          {price !== null ? (
            <>
              <Sum label={t('profit.costs.price')} value={formatEGP(price, locale)} />
              <Sum label={t('profit.costs.leftBeforeAds')} value={formatEGP(price - cost - reserves, locale)} strong />
            </>
          ) : null}
        </dl>

        {current ? (
          <fieldset className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === 'fix'} onChange={() => setMode('fix')} className="mt-1" />
              <span>
                <span className="block font-semibold">{t('profit.costs.modeFix')}</span>
                <span className="block text-xs text-stone-500">{t('profit.costs.modeFixHelp', { date: formatDate(current.effective_from, locale) })}</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} className="mt-1" />
              <span className="flex-1">
                <span className="block font-semibold">{t('profit.costs.modeNew')}</span>
                <span className="block text-xs text-stone-500">{t('profit.costs.modeNewHelp')}</span>
                {mode === 'new' ? (
                  <Input type="date" value={from} onChange={(event) => event.target.value && setFrom(event.target.value)} className="tabular mt-2 min-h-10" />
                ) : null}
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="text-xs text-stone-500">{t('profit.costs.firstHelp')}</p>
        )}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <Button className="w-full" disabled={saving} onClick={() => void save()}>
          {t('profit.costs.save')}
        </Button>

        {sheets.length > 0 ? (
          <div className="space-y-1.5 border-t border-duch-line pt-3">
            <p className="text-xs font-bold text-stone-500">{t('profit.costs.history')}</p>
            {[...sheets].reverse().map((sheet, index) => {
              const each = pieceCost(sheet, null, null);
              return (
                <div key={sheet.id} className="flex items-center gap-2 text-xs">
                  <span className="tabular flex-1 text-stone-600">
                    {index === sheets.length - 1 ? t('profit.costs.fromStart') : t('profit.costs.fromDate', { date: formatDate(sheet.effective_from, locale) })}
                  </span>
                  <span className="tabular font-semibold">
                    {formatEGP(each.cost, locale)}
                  </span>
                  <Button variant="ghost" className="min-h-8 px-2 text-stone-400 hover:text-red-700" aria-label={t('profit.costs.deleteSheet')} onClick={() => void removeSheet(sheet)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Sum({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3', strong && 'font-extrabold')}>
      <dt className={strong ? '' : 'text-stone-500'}>{label}</dt>
      <dd className="tabular">
        {value}
      </dd>
    </div>
  );
}
