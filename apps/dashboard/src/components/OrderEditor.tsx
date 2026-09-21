import { useCallback, useEffect, useMemo, useState } from 'react';
import { PAYMENT_METHODS, calculateInvoiceTotals, formatEGP, normalizeEgyptianPhone } from '@duch/shared';
import type { PaymentMethod } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { Button, ErrorNote, Field, Input, Modal, Select, Spinner } from './ui';

/**
 * Changing an order after it was taken.
 *
 * Everything here is refused by the database once the money has been counted
 * - an order that is paid, or that appears on a courier statement. The screen
 * says so rather than offering fields that will be rejected, but the database
 * is what enforces it.
 */

const ORDER_CHANNELS = ['store', 'online', 'dm'] as const;

interface EditableOrder {
  id: string;
  order_number: string;
  channel: string;
  payment_method: string | null;
  payment_status: string;
  shipping_egp: number;
  discount_egp: number;
  subtotal_egp: number;
  total_egp: number;
  note: string | null;
  cancelled_at: string | null;
  customer_id: string | null;
  customers: { full_name: string | null; phone: string | null } | null;
}

interface LineRow {
  variant_id: string | null;
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_price_egp: number;
}

interface SearchRow {
  variant_id: string;
  sku: string;
  size: string | null;
  color: string | null;
  price_egp: number;
  product_title: string;
  quantity: number;
}

export function OrderEditor({
  order,
  onClose,
  onSaved,
}: {
  order: EditableOrder;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useLocale();

  const [channel, setChannel] = useState(order.channel);
  const [payment, setPayment] = useState<string>(order.payment_method ?? 'cash');
  const [shipping, setShipping] = useState(String(Number(order.shipping_egp) || 0));
  const [discount, setDiscount] = useState(String(Number(order.discount_egp) || 0));
  const [note, setNote] = useState(order.note ?? '');
  const [name, setName] = useState(order.customers?.full_name ?? '');
  const [phone, setPhone] = useState(order.customers?.phone ?? '');

  const [lines, setLines] = useState<LineRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The database refuses these edits; the screen agrees with it rather than
  // offering a field that will bounce.
  const moneyLocked = order.payment_status === 'paid' || order.cancelled_at !== null;

  useEffect(() => {
    supabase
      .from('order_line_items')
      .select('variant_id, sku, title, variant_title, quantity, unit_price_egp')
      .eq('order_id', order.id)
      .order('created_at')
      .then(({ data }) => setLines((data ?? []) as LineRow[]));
  }, [order.id]);

  const runSearch = useCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    const escaped = term.trim().replace(/[%,]/g, '');
    const { data } = await supabase
      .from('v_stock_overview')
      .select('variant_id, sku, size, color, price_egp, product_title, quantity')
      .eq('is_active', true)
      .or(`sku.ilike.%${escaped}%,product_title.ilike.%${escaped}%`)
      .order('sku')
      .limit(10);
    setResults((data ?? []) as SearchRow[]);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const subtotal = useMemo(
    () =>
      (lines ?? []).reduce(
        (sum, line) => sum + Number(line.unit_price_egp) * line.quantity,
        0,
      ),
    [lines],
  );

  const preview = useMemo(
    () =>
      calculateInvoiceTotals({
        subtotal_egp: subtotal,
        discount_egp: Number(discount) || 0,
        shipping_egp: Number(shipping) || 0,
        total_egp: Math.max(0, subtotal - (Number(discount) || 0)),
      }),
    [subtotal, discount, shipping],
  );

  function setQuantity(variantId: string | null, quantity: number) {
    setLines((current) =>
      (current ?? [])
        .map((line) =>
          line.variant_id === variantId ? { ...line, quantity: Math.max(0, quantity) } : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }

  function addLine(row: SearchRow) {
    setLines((current) => {
      const existing = (current ?? []).find((line) => line.variant_id === row.variant_id);
      if (existing) {
        return (current ?? []).map((line) =>
          line.variant_id === row.variant_id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...(current ?? []),
        {
          variant_id: row.variant_id,
          sku: row.sku,
          title: row.product_title,
          variant_title: [row.size, row.color].filter(Boolean).join(' / ') || null,
          quantity: 1,
          unit_price_egp: Number(row.price_egp),
        },
      ];
    });
    setQuery('');
    setResults([]);
  }

  async function save() {
    setSaving(true);
    setError(null);

    try {
      // The customer's own details are theirs, not the order's, so they are
      // updated on the customer record - which is why they stay editable even
      // when the order's money is locked.
      const trimmedName = name.trim();
      const normalisedPhone = normalizeEgyptianPhone(phone);

      if (phone.trim() && !normalisedPhone) {
        setError(t('orders.badPhone'));
        setSaving(false);
        return;
      }

      if (order.customer_id) {
        const { error: customerError } = await supabase
          .from('customers')
          .update({ full_name: trimmedName || null, phone: normalisedPhone })
          .eq('id', order.customer_id);
        if (customerError) throw customerError;
      }

      if (!moneyLocked) {
        const { error: itemsError } = await supabase.rpc('update_order_items', {
          p_order_id: order.id,
          p_items: (lines ?? []).map((line) => ({
            variant_id: line.variant_id,
            quantity: line.quantity,
          })),
        });
        if (itemsError) throw itemsError;
      }

      const { error: detailsError } = await supabase.rpc('update_order_details', {
        p_order_id: order.id,
        p_shipping_egp: moneyLocked ? null : Number(shipping) || 0,
        p_discount_egp: moneyLocked ? null : Number(discount) || 0,
        p_note: note.trim() || null,
        p_payment_method: moneyLocked ? null : payment,
        p_channel: moneyLocked ? null : channel,
      });
      if (detailsError) throw detailsError;

      onSaved();
      onClose();
    } catch (caught) {
      setError((caught as { message?: string })?.message ?? t('app.somethingWentWrong'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open title={`${t("orders.edit")} · ${order.order_number}`} onClose={onClose}>
      <div className="space-y-4">
        {moneyLocked ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {order.cancelled_at ? t('orders.lockedCancelled') : t('orders.lockedPaid')}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('sale.customerName')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('sale.customerPhone')}>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" />
          </Field>
        </div>

        {!moneyLocked ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('sale.channel')}>
              <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {ORDER_CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {t(`channel.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('sale.paymentMethod')}>
              <Select value={payment} onChange={(e) => setPayment(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {t(`payment.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('sale.shipping')}>
              <Input
                value={shipping}
                onChange={(e) => setShipping(e.target.value)}
                inputMode="decimal"
                className="tabular"
              />
            </Field>
            <Field label={t('sale.discount')}>
              <Input
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                inputMode="decimal"
                className="tabular"
              />
            </Field>
          </div>
        ) : null}

        <Field label={t('sale.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {/* The basket. Locked with the money, because changing it moves
            stock against figures that have already been counted. */}
        {!moneyLocked ? (
          <section className="border-t border-duch-line pt-3">
            <h3 className="mb-2 text-xs font-bold text-stone-500">{t('orders.items')}</h3>

            {!lines ? (
              <Spinner />
            ) : (
              <ul className="space-y-2">
                {lines.map((line) => (
                  <li key={line.variant_id ?? line.sku} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <bdi className="block font-semibold">{line.title}</bdi>
                      <span className="tabular block text-xs text-stone-500" dir="ltr">
                        {line.sku}
                        {line.variant_title ? ` · ${line.variant_title}` : ''}
                      </span>
                    </span>

                    <span className="flex items-center gap-1">
                      <Button
                        variant="secondary"
                        className="min-h-9 w-9 px-0"
                        onClick={() => setQuantity(line.variant_id, line.quantity - 1)}
                      >
                        −
                      </Button>
                      <span className="tabular w-8 text-center font-semibold">{line.quantity}</span>
                      <Button
                        variant="secondary"
                        className="min-h-9 w-9 px-0"
                        onClick={() => setQuantity(line.variant_id, line.quantity + 1)}
                      >
                        ＋
                      </Button>
                    </span>

                    <span className="tabular w-24 text-end text-sm font-semibold">
                      {formatEGP(Number(line.unit_price_egp) * line.quantity, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('orders.addItem')}
                autoComplete="off"
              />
              {results.length > 0 ? (
                <ul className="mt-1 divide-y divide-duch-line rounded-lg border border-duch-line">
                  {results.map((row) => (
                    <li key={row.variant_id}>
                      <button
                        type="button"
                        onClick={() => addLine(row)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-stone-50"
                      >
                        <span className="min-w-0 flex-1">
                          <bdi className="block">{row.product_title}</bdi>
                          <span className="tabular block text-xs text-stone-500" dir="ltr">
                            {row.sku}
                          </span>
                        </span>
                        <span className="tabular text-xs text-stone-500">
                          {t('sale.inStock', { count: row.quantity })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <dl className="mt-3 space-y-1 border-t border-duch-line pt-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-stone-600">{t('sale.subtotal')}</dt>
                <dd className="tabular">{formatEGP(subtotal, locale)}</dd>
              </div>
              <div className="flex justify-between font-bold">
                <dt>{t('reports.revenue')}</dt>
                <dd className="tabular">{formatEGP(preview.payable_egp, locale)}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2">
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? t('app.loading') : t('app.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
