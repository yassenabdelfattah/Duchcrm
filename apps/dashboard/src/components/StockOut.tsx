import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDate, formatDateTime } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { useLocale } from '../i18n';
import {
  Button,
  Card,
  Code,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Spinner,
  StatusPill,
  cx,
  type StatusTone,
} from './ui';

/**
 * Taking stock out without an order - a photoshoot, a gift, something
 * damaged, or a reason typed in - and keeping track of what has to come back.
 *
 * Every piece that leaves is a stock movement against a stock-out record, so
 * it shows in the stock history with the reason and who did it, and Shopify
 * drops the number at once. See the stock_out migration.
 */

type OutReason = 'photoshoot' | 'gift' | 'damaged' | 'other';
const REASONS: OutReason[] = ['photoshoot', 'gift', 'damaged', 'other'];

type OutStatus = 'out' | 'overdue' | 'returned' | 'kept' | 'gone';

interface OutLine {
  id: string;
  sku: string;
  title: string;
  size: string | null;
  color: string | null;
  quantity: number;
  returned: number;
}

interface StockOutRow {
  id: string;
  reason: OutReason;
  reason_text: string | null;
  taken_by: string | null;
  note: string | null;
  expects_return: boolean;
  return_by: string | null;
  created_at: string;
  closed_at: string | null;
  close_note: string | null;
  created_by_name: string | null;
  status: OutStatus;
  quantity: number;
  outstanding: number;
  lines: OutLine[];
}

const STATUS_TONE: Record<OutStatus, StatusTone> = {
  out: 'wait',
  overdue: 'back',
  returned: 'done',
  kept: 'closed',
  gone: 'closed',
};

function reasonLabel(row: { reason: OutReason; reason_text: string | null }, t: (k: string) => string): string {
  return row.reason === 'other' ? (row.reason_text ?? t('stockOut.reason.other')) : t(`stockOut.reason.${row.reason}`);
}

function variantLabel(line: { size: string | null; color: string | null }): string {
  return [line.size, line.color].filter(Boolean).join(' / ');
}

// --- The list ---------------------------------------------------------------------

export function StockOutList({ mayAdjust, reloadToken }: { mayAdjust: boolean; reloadToken: number }) {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<StockOutRow[] | null>(null);
  const [status, setStatus] = useState<'' | 'open' | OutStatus>('open');
  const [reason, setReason] = useState<'' | OutReason>('');
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState<StockOutRow | null>(null);
  const [closing, setClosing] = useState<StockOutRow | null>(null);
  const [localReload, setLocalReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);

    let query = supabase.from('v_stock_outs').select('*').order('created_at', { ascending: false }).limit(200);
    if (status === 'open') query = query.in('status', ['out', 'overdue']);
    else if (status) query = query.eq('status', status);
    if (reason) query = query.eq('reason', reason);

    void query.then(({ data, error: queryError }) => {
      if (cancelled) return;
      if (queryError) setError(arabicError(queryError));
      else {
        setError(null);
        setRows((data ?? []) as StockOutRow[]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [status, reason, reloadToken, localReload]);

  const reload = () => setLocalReload((n) => n + 1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="min-h-9 rounded-lg border border-duch-line bg-white px-2.5 text-sm font-semibold"
        >
          <option value="open">{t('stockOut.filter.open')}</option>
          <option value="">{t('stockOut.filter.all')}</option>
          {(['overdue', 'returned', 'kept', 'gone'] as OutStatus[]).map((value) => (
            <option key={value} value={value}>
              {t(`stockOut.status.${value}`)}
            </option>
          ))}
        </select>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as typeof reason)}
          className="min-h-9 rounded-lg border border-duch-line bg-white px-2.5 text-sm font-semibold"
        >
          <option value="">{t('stockOut.filter.allReasons')}</option>
          {REASONS.map((value) => (
            <option key={value} value={value}>
              {t(`stockOut.reason.${value}`)}
            </option>
          ))}
        </select>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('stockOut.empty')} />
      ) : (
        rows.map((row) => (
          <Card key={row.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold">
                <bdi>{reasonLabel(row, t)}</bdi>
              </span>
              <StatusPill tone={STATUS_TONE[row.status]}>
                {row.status === 'out' && row.return_by
                  ? t('stockOut.status.outUntil', { date: formatDate(row.return_by, locale) })
                  : t(`stockOut.status.${row.status}`)}
              </StatusPill>
              <span className="text-xs text-stone-500">
                {formatDateTime(row.created_at, locale)}
                {row.created_by_name ? (
                  <>
                    {' · '}
                    <bdi>{row.created_by_name}</bdi>
                  </>
                ) : null}
              </span>
            </div>

            {row.taken_by ? (
              <p className="text-sm">
                <span className="text-stone-500">{t('stockOut.takenBy')}: </span>
                <bdi className="font-semibold">{row.taken_by}</bdi>
              </p>
            ) : null}

            <ul className="divide-y divide-duch-line rounded-lg border border-duch-line text-sm">
              {row.lines.map((line) => (
                <li key={line.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      <bdi>{line.title}</bdi>
                    </span>
                    <span className="block text-xs text-stone-500">
                      {variantLabel(line) ? `${variantLabel(line)} · ` : ''}
                      <Code>{line.sku}</Code>
                    </span>
                  </span>
                  <span className="tabular whitespace-nowrap text-stone-700">
                    ×{line.quantity}
                    {row.expects_return && line.returned > 0 ? (
                      <span className="ms-2 text-xs text-emerald-700">
                        {t('stockOut.returnedCount', { count: line.returned })}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>

            {row.note || row.close_note ? (
              <p className="text-xs text-stone-600">
                <bdi>{[row.note, row.close_note].filter(Boolean).join(' · ')}</bdi>
              </p>
            ) : null}

            {mayAdjust && (row.status === 'out' || row.status === 'overdue') ? (
              <div className="flex flex-wrap gap-2 border-t border-duch-line pt-2">
                <Button className="min-h-9 px-3 text-xs" onClick={() => setReturning(row)}>
                  {t('stockOut.recordReturn')}
                </Button>
                <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => setClosing(row)}>
                  {t('stockOut.notComingBack')}
                </Button>
              </div>
            ) : null}
          </Card>
        ))
      )}

      {returning ? (
        <ReturnDialog
          row={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            reload();
          }}
        />
      ) : null}

      {closing ? (
        <CloseDialog
          row={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

// --- Taking stock out -------------------------------------------------------------

interface PickRow {
  variant_id: string;
  sku: string;
  size: string | null;
  color: string | null;
  product_title: string;
  quantity: number;
}

interface Picked extends PickRow {
  take: number;
}

/**
 * A date some days from today, as the date input wants it. Built from the
 * local calendar date - toISOString() would give the UTC date, which in
 * Cairo is yesterday until 2 or 3 in the morning.
 */
function addDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function StockOutDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useLocale();
  const [locationId, setLocationId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickRow[]>([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [reason, setReason] = useState<OutReason>('photoshoot');
  const [reasonText, setReasonText] = useState('');
  const [expectsReturn, setExpectsReturn] = useState(true);
  const [returnBy, setReturnBy] = useState(addDays(7));
  const [takenBy, setTakenBy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per dialog, so a second tap on the button returns the first
  // stock-out instead of taking the pieces out twice.
  const idempotencyKey = useRef(`stock-out-${crypto.randomUUID()}`);

  useEffect(() => {
    void supabase
      .from('locations')
      .select('id')
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setLocationId((data?.id as string | undefined) ?? null));
  }, []);

  const search = useCallback(
    async (term: string) => {
      if (!locationId || term.trim().length < 2) {
        setResults([]);
        return;
      }
      const escaped = term.trim().replace(/[%,()]/g, '');
      const { data } = await supabase
        .from('v_stock_overview')
        .select('variant_id, sku, size, color, product_title, quantity')
        .eq('location_id', locationId)
        .eq('is_active', true)
        .or(`sku.ilike.%${escaped}%,barcode.ilike.%${escaped}%,product_title.ilike.%${escaped}%`)
        .order('sku')
        .limit(30);
      setResults((data ?? []) as PickRow[]);
    },
    [locationId],
  );

  useEffect(() => {
    const timer = setTimeout(() => void search(query), 220);
    return () => clearTimeout(timer);
  }, [query, search]);

  function pick(row: PickRow) {
    setError(null);
    setPicked((current) => {
      const existing = current.find((item) => item.variant_id === row.variant_id);
      if (existing) {
        return current.map((item) =>
          item.variant_id === row.variant_id ? { ...item, take: Math.min(item.take + 1, row.quantity) } : item,
        );
      }
      return [...current, { ...row, take: 1 }];
    });
    setQuery('');
    setResults([]);
  }

  function setTake(variantId: string, take: number) {
    setPicked((current) =>
      current
        .map((item) => (item.variant_id === variantId ? { ...item, take: Math.max(0, Math.min(take, item.quantity)) } : item))
        .filter((item) => item.take > 0),
    );
  }

  function chooseReason(next: OutReason) {
    setReason(next);
    // A photoshoot usually comes back; a gift or a damaged piece does not.
    setExpectsReturn(next === 'photoshoot');
  }

  const total = picked.reduce((sum, item) => sum + item.take, 0);

  async function submit() {
    if (picked.length === 0) {
      setError(t('stockOut.pickItems'));
      return;
    }
    if (reason === 'other' && !reasonText.trim()) {
      setError(t('stockOut.reasonNeeded'));
      return;
    }

    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('record_stock_out', {
      p_location_id: locationId,
      p_reason: reason,
      p_reason_text: reason === 'other' ? reasonText.trim() : null,
      p_items: picked.map((item) => ({ variant_id: item.variant_id, quantity: item.take })),
      p_taken_by: takenBy.trim() || null,
      p_note: note.trim() || null,
      p_expects_return: expectsReturn,
      p_return_by: expectsReturn && returnBy ? returnBy : null,
      p_idempotency_key: idempotencyKey.current,
    });

    setBusy(false);

    if (rpcError) {
      if (/insufficient_stock/.test(`${rpcError.message} ${rpcError.hint ?? ''}`)) {
        const variantId = /variant ([0-9a-f-]+)/i.exec(rpcError.message)?.[1];
        const item = picked.find((p) => p.variant_id === variantId);
        setError(t('stockOut.notEnough', { sku: item?.sku ?? '' }));
      } else {
        setError(arabicError(rpcError));
      }
      return;
    }

    // Fast path to Shopify; the outbox covers it if this call does not land.
    void supabase.functions
      .invoke('push-inventory', {
        body: { variant_ids: picked.map((item) => item.variant_id), location_id: locationId },
      })
      .catch(() => undefined);

    onDone();
  }

  return (
    <Modal open title={t('stockOut.title')} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Field label={t('stockOut.items')}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sale.searchPlaceholder')}
              autoComplete="off"
              autoFocus
            />
          </Field>
          {results.length > 0 ? (
            <ul className="mt-1 max-h-56 divide-y divide-duch-line overflow-y-auto rounded-lg border border-duch-line">
              {results.map((row) => (
                <li key={row.variant_id}>
                  <button
                    type="button"
                    disabled={row.quantity <= 0}
                    onClick={() => pick(row)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-start text-sm hover:bg-stone-50 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        <bdi>{row.product_title}</bdi>
                      </span>
                      <span className="block text-xs text-stone-500">
                        {variantLabel(row) ? `${variantLabel(row)} · ` : ''}
                        <Code>{row.sku}</Code>
                      </span>
                    </span>
                    <span className="tabular text-xs text-stone-600">
                      {row.quantity <= 0 ? t('sale.outOfStock') : t('sale.inStock', { count: row.quantity })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {picked.length > 0 ? (
            <ul className="mt-2 divide-y divide-duch-line rounded-lg border border-duch-ink text-sm">
              {picked.map((item) => (
                <li key={item.variant_id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      <bdi>{item.product_title}</bdi>
                    </span>
                    <span className="block text-xs text-stone-500">
                      {variantLabel(item) ? `${variantLabel(item)} · ` : ''}
                      <Code>{item.sku}</Code>
                    </span>
                  </span>
                  <Button variant="secondary" className="min-h-8 px-2.5" onClick={() => setTake(item.variant_id, item.take - 1)}>
                    −
                  </Button>
                  <span className="tabular w-6 text-center font-bold">{item.take}</span>
                  <Button
                    variant="secondary"
                    className="min-h-8 px-2.5"
                    disabled={item.take >= item.quantity}
                    onClick={() => setTake(item.variant_id, item.take + 1)}
                  >
                    +
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold text-stone-600">{t('stockOut.reasonLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseReason(value)}
                className={cx(
                  'min-h-9 rounded-lg border px-3 text-sm font-semibold',
                  reason === value ? 'border-duch-ink bg-duch-ink text-white' : 'border-duch-line bg-white text-stone-700',
                )}
              >
                {t(`stockOut.reason.${value}`)}
              </button>
            ))}
          </div>
          {reason === 'other' ? (
            <Input
              className="mt-2"
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              placeholder={t('stockOut.reasonPlaceholder')}
            />
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={expectsReturn}
            onChange={(event) => setExpectsReturn(event.target.checked)}
            className="size-4 accent-duch-ink"
          />
          {t('stockOut.comesBack')}
        </label>
        {expectsReturn ? (
          <Field label={t('stockOut.returnBy')}>
            <Input type="date" value={returnBy} onChange={(event) => setReturnBy(event.target.value)} />
          </Field>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('stockOut.takenBy')}>
            <Input value={takenBy} onChange={(event) => setTakenBy(event.target.value)} placeholder={t('stockOut.takenByHint')} />
          </Field>
          <Field label={t('queue.note')}>
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy || total === 0}>
            {busy ? t('app.loading') : t('stockOut.submit', { count: total })}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Pieces coming back ------------------------------------------------------------

function ReturnDialog({ row, onClose, onDone }: { row: StockOutRow; onClose: () => void; onDone: () => void }) {
  const { t } = useLocale();
  // Defaults to everything that is still out, the usual case.
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(row.lines.map((line) => [line.id, line.quantity - line.returned])),
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const items = row.lines
      .map((line) => ({ line_id: line.id, quantity: counts[line.id] ?? 0 }))
      .filter((item) => item.quantity > 0);
    if (items.length === 0) {
      setError(t('stockOut.pickReturned'));
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('return_stock_out', {
      p_stock_out_id: row.id,
      p_items: items,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onDone();
  }

  return (
    <Modal open title={t('stockOut.recordReturn')} onClose={onClose}>
      <div className="space-y-3">
        <ul className="divide-y divide-duch-line rounded-lg border border-duch-line text-sm">
          {row.lines
            .filter((line) => line.returned < line.quantity)
            .map((line) => {
              const remaining = line.quantity - line.returned;
              return (
                <li key={line.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      <bdi>{line.title}</bdi>
                    </span>
                    <span className="block text-xs text-stone-500">
                      {variantLabel(line) ? `${variantLabel(line)} · ` : ''}
                      <Code>{line.sku}</Code> · {t('stockOut.stillOut', { count: remaining })}
                    </span>
                  </span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={remaining}
                    value={counts[line.id] ?? 0}
                    onChange={(event) =>
                      setCounts((current) => ({
                        ...current,
                        [line.id]: Math.max(0, Math.min(remaining, Number(event.target.value) || 0)),
                      }))
                    }
                    className="tabular w-20 text-center"
                  />
                </li>
              );
            })}
        </ul>
        <Field label={t('queue.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('app.loading') : t('stockOut.confirmReturn')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CloseDialog({ row, onClose, onDone }: { row: StockOutRow; onClose: () => void; onDone: () => void }) {
  const { t } = useLocale();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('close_stock_out', {
      p_stock_out_id: row.id,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onDone();
  }

  return (
    <Modal open title={t('stockOut.notComingBack')} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">
          {t('stockOut.closeHelp', { count: row.outstanding })}
        </p>
        <Field label={t('stockOut.closeReason')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('app.loading') : t('stockOut.notComingBack')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
