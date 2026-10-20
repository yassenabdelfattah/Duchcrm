import { useCallback, useEffect, useMemo, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { compareVariants, formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { isolate, useLocale } from '../i18n';
import { Button, ErrorNote, Field, Input, Modal, Select, cx } from './ui';
import { ScanButton } from './ScanButton';

/**
 * Swapping a delivered piece for another (DECISIONS #13).
 *
 * The old piece comes back and a replacement goes out, as a new order linked
 * to the original. The database works out the money; this screen shows the
 * same sum first so nobody confirms a number they have not seen. In the shop
 * both happen at the counter; by courier the replacement joins the packing
 * queue and the courier collects the old piece at the door.
 */

export interface ExchangeOrder {
  id: string;
  order_number: string;
  subtotal_egp: number;
  total_egp: number;
  shipping_egp: number;
}

export interface ExchangeResult {
  replacement_order_number: string;
  /** In the shop any difference was handed back on the spot. */
  in_store: boolean;
  amount_due_egp: number;
  refund_due_egp: number;
}

interface OriginalLine {
  id: string;
  variant_id: string | null;
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  total_egp: number;
}

interface StockRow {
  variant_id: string;
  product_id: string;
  sku: string;
  size: string | null;
  color: string | null;
  price_egp: number;
  product_title: string;
  quantity: number;
}

interface NewLine {
  row: StockRow;
  quantity: number;
}

/** Customer's choice: they pay the courier. Our mistake: free. */
const REASONS = [
  { key: 'wrong_size', customerPays: true },
  { key: 'not_as_expected', customerPays: true },
  { key: 'faulty', customerPays: false },
  { key: 'wrong_item_sent', customerPays: false },
] as const;

type Reason = (typeof REASONS)[number]['key'];

const SHOP_METHODS = ['cash', 'card', 'instapay'] as const;

export function ExchangeDialog({
  order,
  onClose,
  onDone,
}: {
  order: ExchangeOrder;
  onClose: () => void;
  onDone: (result: ExchangeResult) => void;
}) {
  const { t, locale } = useLocale();
  const [inStore, setInStore] = useState(false);
  const [lines, setLines] = useState<OriginalLine[] | null>(null);
  const [back, setBack] = useState<Record<string, number>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<Reason>('wrong_size');
  const [shipping, setShipping] = useState(String(Number(order.shipping_egp) || 0));
  const [method, setMethod] = useState<(typeof SHOP_METHODS)[number]>('cash');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockRow[]>([]);
  const [siblings, setSiblings] = useState<StockRow[]>([]);
  const [added, setAdded] = useState<NewLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key for the life of the dialog: a double tap is the same exchange.
  const [idempotencyKey] = useState(() => `exchange-${crypto.randomUUID()}`);

  useEffect(() => {
    supabase
      .from('order_line_items')
      .select('id, variant_id, sku, title, variant_title, quantity, total_egp')
      .eq('order_id', order.id)
      .order('created_at')
      .then(({ data }) => {
        const rows = (data ?? []) as OriginalLine[];
        setLines(rows);
        // One piece on the order: that is the one coming back.
        const only = rows.length === 1 ? rows[0] : undefined;
        if (only && only.quantity === 1) setBack({ [only.id]: 1 });
      });
  }, [order.id]);

  // The usual exchange is the same product in another size, so those sizes
  // are offered first, one tap each.
  const returningVariants = useMemo(
    () => (lines ?? []).filter((line) => (back[line.id] ?? 0) > 0 && line.variant_id).map((line) => line.variant_id as string),
    [lines, back],
  );

  useEffect(() => {
    if (returningVariants.length === 0) {
      setSiblings([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data: own } = await supabase
        .from('v_stock_overview')
        .select('product_id')
        .in('variant_id', returningVariants);
      const products = [...new Set((own ?? []).map((row) => row.product_id as string))];
      if (products.length === 0) return;
      const { data } = await supabase
        .from('v_stock_overview')
        .select('variant_id, product_id, sku, size, color, price_egp, product_title, quantity')
        .in('product_id', products)
        .eq('is_active', true);
      if (cancelled) return;
      const rows = ((data ?? []) as StockRow[]).filter((row) => !returningVariants.includes(row.variant_id));
      rows.sort(compareVariants);
      setSiblings(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [returningVariants]);

  const runSearch = useCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    const escaped = term.trim().replace(/[%,]/g, '');
    const { data } = await supabase
      .from('v_stock_overview')
      .select('variant_id, product_id, sku, size, color, price_egp, product_title, quantity')
      .eq('is_active', true)
      .or(`sku.ilike.%${escaped}%,product_title.ilike.%${escaped}%,barcode.eq.${escaped}`)
      .order('sku')
      .limit(10);
    setResults((data ?? []) as StockRow[]);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  function add(row: StockRow) {
    setAdded((current) => {
      const existing = current.find((line) => line.row.variant_id === row.variant_id);
      if (existing) {
        return current.map((line) =>
          line.row.variant_id === row.variant_id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [...current, { row, quantity: 1 }];
    });
    setQuery('');
    setResults([]);
  }

  function chooseReason(next: Reason) {
    setReason(next);
    const rule = REASONS.find((r) => r.key === next);
    setShipping(rule?.customerPays ? String(Number(order.shipping_egp) || 0) : '0');
  }

  // The same sum the database makes: what the customer paid for the piece,
  // the order's own discount spread across it.
  const factor = Number(order.subtotal_egp) > 0 ? Number(order.total_egp) / Number(order.subtotal_egp) : 1;
  const credit = (lines ?? []).reduce(
    (sum, line) => sum + (Number(line.total_egp) / line.quantity) * factor * (back[line.id] ?? 0),
    0,
  );
  const goods = added.reduce((sum, line) => sum + Number(line.row.price_egp) * line.quantity, 0);
  const fee = inStore ? 0 : Math.max(0, Number(shipping) || 0);
  const applied = Math.min(credit, goods);
  const refund = credit - applied;
  const due = goods - applied + fee;
  const piecesBack = Object.values(back).reduce((sum, n) => sum + n, 0);

  async function confirm() {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('create_exchange', {
      p_order_id: order.id,
      p_return_lines: (lines ?? [])
        .filter((line) => (back[line.id] ?? 0) > 0)
        .map((line) => ({
          order_line_item_id: line.id,
          quantity: back[line.id],
          quantity_damaged: inStore && damaged[line.id] ? back[line.id] : 0,
        })),
      p_replacement_items: added.map((line) => ({ variant_id: line.row.variant_id, quantity: line.quantity })),
      p_reason: reason,
      p_in_store: inStore,
      p_shipping_egp: fee,
      p_payment_method: inStore ? method : null,
      p_note: note.trim() || null,
      p_idempotency_key: idempotencyKey,
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    const result = data as { replacement_order_number: string; amount_due_egp: number; refund_due_egp: number };
    onDone({
      replacement_order_number: result.replacement_order_number,
      in_store: inStore,
      amount_due_egp: Number(result.amount_due_egp),
      refund_due_egp: Number(result.refund_due_egp),
    });
  }

  const stepper = (value: number, set: (n: number) => void, max: number) => (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="−"
        onClick={() => set(Math.max(0, value - 1))}
        className="flex size-9 items-center justify-center rounded-lg border border-duch-line"
      >
        <Minus className="size-4" />
      </button>
      <span className="tabular w-6 text-center font-bold">{value}</span>
      <button
        type="button"
        aria-label="+"
        onClick={() => set(Math.min(max, value + 1))}
        className="flex size-9 items-center justify-center rounded-lg border border-duch-line"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );

  return (
    <Modal open title={`${t('exchange.title')} · ${isolate(order.order_number)}`} onClose={onClose}>
      <div className="space-y-4">
        {/* Where it happens decides who carries what. */}
        <div className="grid grid-cols-2 gap-2">
          {[false, true].map((shop) => (
            <button
              key={String(shop)}
              type="button"
              onClick={() => setInStore(shop)}
              className={cx(
                'min-h-11 rounded-lg border px-3 text-sm font-bold',
                inStore === shop ? 'border-duch-ink bg-duch-ink text-white' : 'border-duch-line bg-white text-stone-600',
              )}
            >
              {shop ? t('exchange.inStore') : t('exchange.byCourier')}
            </button>
          ))}
        </div>
        <p className="text-xs text-stone-500">{inStore ? t('exchange.inStoreHelp') : t('exchange.byCourierHelp')}</p>

        <section className="space-y-2">
          <h3 className="text-sm font-extrabold">{t('exchange.comingBack')}</h3>
          {(lines ?? []).map((line) => (
            <div key={line.id} className="flex items-center gap-3 rounded-lg border border-duch-line p-2">
              <div className="min-w-0 flex-1 text-sm">
                <bdi className="block font-semibold">{line.title}</bdi>
                <span className="tabular block text-xs text-stone-500" dir="ltr">
                  {line.sku}
                </span>
                {inStore && (back[line.id] ?? 0) > 0 ? (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-stone-600">
                    <input
                      type="checkbox"
                      checked={Boolean(damaged[line.id])}
                      onChange={(event) => setDamaged((d) => ({ ...d, [line.id]: event.target.checked }))}
                    />
                    {t('exchange.damaged')}
                  </label>
                ) : null}
              </div>
              {stepper(back[line.id] ?? 0, (n) => setBack((b) => ({ ...b, [line.id]: n })), line.quantity)}
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-extrabold">{t('exchange.goingOut')}</h3>

          {siblings.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {siblings.map((row) => (
                <button
                  key={row.variant_id}
                  type="button"
                  disabled={row.quantity <= 0}
                  onClick={() => add(row)}
                  className={cx(
                    'min-h-9 rounded-lg border px-3 text-xs font-bold',
                    row.quantity > 0
                      ? 'border-duch-line bg-white text-duch-ink hover:bg-stone-50'
                      : 'border-dashed border-stone-200 text-stone-300',
                  )}
                >
                  {[row.size, row.color].filter(Boolean).join(' / ') || row.sku}
                  <span className="ms-1 font-normal text-stone-500">({row.quantity})</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('exchange.searchOther')}
              autoComplete="off"
              className="min-w-0 flex-1"
            />
            <ScanButton onScan={setQuery} />
          </div>
          {results.length > 0 ? (
            <ul className="divide-y divide-duch-line rounded-lg border border-duch-line">
              {results.map((row) => (
                <li key={row.variant_id}>
                  <button
                    type="button"
                    disabled={row.quantity <= 0}
                    onClick={() => add(row)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-stone-50 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <bdi className="block">{row.product_title}</bdi>
                      <span className="tabular block text-xs text-stone-500" dir="ltr">
                        {row.sku}
                      </span>
                    </span>
                    <span className="tabular text-xs text-stone-500">{t('sale.inStock', { count: row.quantity })}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {added.map((line) => (
            <div key={line.row.variant_id} className="flex items-center gap-3 rounded-lg bg-stone-50 p-2">
              <div className="min-w-0 flex-1 text-sm">
                <bdi className="block font-semibold">{line.row.product_title}</bdi>
                <span className="tabular block text-xs text-stone-500">
                  <span dir="ltr">{line.row.sku}</span> · {formatEGP(Number(line.row.price_egp), locale)}
                </span>
              </div>
              {stepper(
                line.quantity,
                (n) =>
                  setAdded((current) =>
                    n === 0
                      ? current.filter((l) => l.row.variant_id !== line.row.variant_id)
                      : current.map((l) => (l.row.variant_id === line.row.variant_id ? { ...l, quantity: n } : l)),
                  ),
                Math.max(line.row.quantity, line.quantity),
              )}
              <button
                type="button"
                aria-label={t('app.close')}
                onClick={() => setAdded((current) => current.filter((l) => l.row.variant_id !== line.row.variant_id))}
                className="p-1 text-stone-400"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-extrabold">{t('exchange.why')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => chooseReason(r.key)}
                className={cx(
                  'min-h-11 rounded-lg border px-3 text-start text-xs font-semibold',
                  reason === r.key ? 'border-duch-ink bg-duch-ink text-white' : 'border-duch-line bg-white text-stone-600',
                )}
              >
                {t(`returnReason.${r.key}`)}
              </button>
            ))}
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          {inStore ? (
            due > 0 ? (
              <Field label={t('exchange.paidBy')}>
                <Select value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                  {SHOP_METHODS.map((value) => (
                    <option key={value} value={value}>
                      {t(`payment.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null
          ) : (
            <Field label={t('exchange.courierFee')}>
              <Input
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                inputMode="decimal"
                dir="ltr"
              />
            </Field>
          )}
          <Field label={t('sale.note')}>
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>

        {/* The sum, before anyone confirms it. */}
        <dl className="tabular space-y-1 rounded-xl bg-stone-50 p-3 text-sm">
          <div className="flex justify-between">
            <dt>{t('exchange.credit')}</dt>
            <dd>{formatEGP(credit, locale)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>{t('exchange.newPieces')}</dt>
            <dd>{formatEGP(goods, locale)}</dd>
          </div>
          {!inStore ? (
            <div className="flex justify-between">
              <dt>{t('exchange.courierFee')}</dt>
              <dd>{formatEGP(fee, locale)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-duch-line pt-1 text-base font-extrabold">
            <dt>{refund > 0 ? t('exchange.weOwe') : t('exchange.customerPays')}</dt>
            <dd className={refund > 0 ? 'text-amber-700' : undefined}>
              {formatEGP(refund > 0 ? refund : due, locale)}
            </dd>
          </div>
          {refund > 0 && fee > 0 ? (
            <p className="text-xs text-stone-500">{t('exchange.feeStillPaid', { fee: formatEGP(fee, locale) })}</p>
          ) : null}
        </dl>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('orders.keepOrder')}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || piecesBack === 0 || added.length === 0}>
            {busy ? t('app.loading') : t('exchange.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
