import { useEffect, useMemo, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { STOCK_MOVEMENT_REASONS, can, formatEGP, type StockMovementReason } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
} from '../components/ui';

interface StockRow {
  variant_id: string;
  sku: string;
  size: string | null;
  color: string | null;
  price_egp: number;
  product_title: string;
  product_title_ar: string | null;
  quantity: number;
  stock_updated_at: string | null;
  location_id: string;
  location_name: string;
  is_low_stock: boolean;
  is_out_of_stock: boolean;
  is_unlinked: boolean;
}

/** Reasons a person can pick when adjusting by hand. The rest are machine-written. */
const MANUAL_REASONS: StockMovementReason[] = STOCK_MOVEMENT_REASONS.filter((reason) =>
  ['adjustment', 'production_in', 'return'].includes(reason),
);

export function Stock() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayAdjust = can(identity?.role, 'stock.adjust');

  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);

    supabase
      .from('v_stock_overview')
      .select(
        'variant_id, sku, size, color, price_egp, product_title, product_title_ar, quantity, stock_updated_at, location_id, location_name, is_low_stock, is_out_of_stock, is_unlinked',
      )
      .eq('is_active', true)
      .order('product_title')
      .order('sku')
      .limit(1000)
      .then(({ data }) => {
        if (!cancelled) setRows((data ?? []) as StockRow[]);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (lowOnly && !row.is_low_stock && !row.is_out_of_stock) return false;
      if (!term) return true;
      return (
        row.sku.toLowerCase().includes(term) ||
        row.product_title.toLowerCase().includes(term) ||
        (row.product_title_ar ?? '').includes(term)
      );
    });
  }, [rows, search, lowOnly]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-lg font-extrabold">{t('stock.title')}</h1>
        <div className="ms-auto flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('app.search')}
            className="w-56"
          />
          <label className="flex items-center gap-2 text-sm font-semibold text-stone-600">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(event) => setLowOnly(event.target.checked)}
              className="size-4 accent-duch-ink"
            />
            {t('stock.lowOnly')}
          </label>
        </div>
      </div>

      {!filtered ? (
        <Spinner label={t('app.loading')} />
      ) : filtered.length === 0 ? (
        <EmptyState title={t('stock.empty')} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-duch-line bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3 text-start font-semibold">{t('stock.product')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('stock.sku')}</th>
                <th className="px-4 py-3 text-end font-semibold">{t('sale.unitPrice')}</th>
                <th className="px-4 py-3 text-end font-semibold">{t('stock.quantity')}</th>
                {mayAdjust ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-duch-line">
              {filtered.map((row) => (
                <tr key={`${row.variant_id}:${row.location_id}`}>
                  <td className="px-4 py-3">
                    <span className="block font-semibold">
                      {locale === 'ar' && row.product_title_ar
                        ? row.product_title_ar
                        : row.product_title}
                    </span>
                    <span className="text-xs text-stone-500">
                      {[row.size, row.color].filter(Boolean).join(' / ')}
                    </span>
                  </td>
                  <td className="tabular px-4 py-3">
                    {row.sku}
                    {row.is_unlinked ? (
                      <span className="ms-2">
                        <Badge tone="warn">{t('stock.notSynced')}</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular px-4 py-3 text-end">
                    {formatEGP(Number(row.price_egp), locale)}
                  </td>
                  <td className="tabular px-4 py-3 text-end font-bold">
                    <Badge
                      tone={row.is_out_of_stock ? 'bad' : row.is_low_stock ? 'warn' : 'neutral'}
                    >
                      {row.quantity}
                    </Badge>
                  </td>
                  {mayAdjust ? (
                    <td className="px-4 py-3 text-end">
                      <Button
                        variant="secondary"
                        className="min-h-9 text-xs"
                        onClick={() => setAdjusting(row)}
                      >
                        {t('stock.adjust')}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <AdjustDialog
        row={adjusting}
        onClose={() => setAdjusting(null)}
        onDone={() => {
          setAdjusting(null);
          setReloadToken((token) => token + 1);
        }}
      />
    </div>
  );
}

function AdjustDialog({
  row,
  onClose,
  onDone,
}: {
  row: StockRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<StockMovementReason>('adjustment');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDelta('');
    setReason('adjustment');
    setNote('');
    setError(null);
  }, [row?.variant_id]);

  if (!row) return null;

  // Captured into a const so the null check above still holds inside submit().
  // TypeScript discards narrowing on a parameter once it is read from a
  // closure, since the closure could in principle run after it changed.
  const target = row;

  async function submit() {
    const amount = Number(delta);
    if (!Number.isInteger(amount) || amount === 0) {
      setError(t('stock.adjustAmount'));
      return;
    }

    setSaving(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('record_stock_movements', {
      p_location_id: target.location_id,
      p_reason: reason,
      p_movements: [{ variant_id: target.variant_id, quantity_delta: amount }],
      p_reference_type: 'manual_adjustment',
      p_reference_id: null,
      p_note: note || null,
    });

    setSaving(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    // Fast path to Shopify; the outbox covers it if this call does not land.
    void supabase.functions
      .invoke('push-inventory', {
        body: { variant_ids: [target.variant_id], location_id: target.location_id },
      })
      .catch(() => undefined);

    onDone();
  }

  return (
    <Modal open title={t('stock.adjustTitle', { sku: row.sku })} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
          {t('stock.adjustHelp')}
        </p>

        <Field label={t('stock.adjustAmount')}>
          <Input
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            inputMode="numeric"
            placeholder="-1"
            className="tabular"
            dir="ltr"
          />
        </Field>

        <Field label={t('stock.adjustReason')}>
          <Select
            value={reason}
            onChange={(event) => setReason(event.target.value as StockMovementReason)}
          >
            {MANUAL_REASONS.map((value) => (
              <option key={value} value={value}>
                {t(`reason.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('stock.adjustNote')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={saving}>
            {saving ? t('app.loading') : t('app.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
