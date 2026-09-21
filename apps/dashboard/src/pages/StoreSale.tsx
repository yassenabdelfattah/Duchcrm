import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PAYMENT_METHODS,
  calculateBasket,
  formatEGP,
  normalizeEgyptianPhone,
  type PaymentMethod,
} from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Select, Spinner } from '../components/ui';
import { Invoice } from '../components/Invoice';
import { Receipt } from '../components/Receipt';

interface StockRow {
  variant_id: string;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  price_egp: number;
  product_title: string;
  product_title_ar: string | null;
  quantity: number;
  location_id: string;
}

interface BasketLine {
  variant_id: string;
  sku: string;
  title: string;
  variant_label: string;
  unit_price_egp: number;
  quantity: number;
  available: number;
}

export interface CompletedSale {
  order_id: string;
  order_number: string;
  channel: OrderChannel;
  shipping_egp: number;
  total_egp: number;
  payment_method: PaymentMethod;
  created_at: string;
  lines: BasketLine[];
}

/**
 * The channels an order can be taken through by hand.
 *
 * `wholesale` is deliberately absent: it is Phase 4 and has its own pricing
 * and terms, so offering it here would create orders the wholesale flow does
 * not yet know how to finish.
 */
const ORDER_CHANNELS = ['store', 'online', 'dm'] as const;
type OrderChannel = (typeof ORDER_CHANNELS)[number];

/** A fresh key per sale. Reused across retries of the same sale, never between sales. */
const newIdempotencyKey = () =>
  `sale-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function StoreSale() {
  const { t, locale } = useLocale();

  const [locationId, setLocationId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [channel, setChannel] = useState<OrderChannel>('store');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [shipping, setShipping] = useState('');
  const [note, setNote] = useState('');
  const [discount, setDiscount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const [showInvoice, setShowInvoice] = useState(false);

  const idempotencyKey = useRef(newIdempotencyKey());
  const searchBox = useRef<HTMLInputElement>(null);

  // --- Which location are we selling from? ---------------------------------

  useEffect(() => {
    supabase
      .from('locations')
      .select('id')
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setLocationId((data?.id as string | undefined) ?? null));
  }, []);

  // --- Search --------------------------------------------------------------

  const runSearch = useCallback(
    async (term: string): Promise<StockRow[]> => {
      if (!locationId || term.trim().length < 2) return [];
      const escaped = term.trim().replace(/[%,]/g, '');

      const { data, error: searchError } = await supabase
        .from('v_stock_overview')
        .select(
          'variant_id, sku, barcode, size, color, price_egp, product_title, product_title_ar, quantity, location_id',
        )
        .eq('location_id', locationId)
        .eq('is_active', true)
        .or(`sku.ilike.%${escaped}%,barcode.ilike.%${escaped}%,product_title.ilike.%${escaped}%`)
        .order('sku')
        .limit(25);

      if (searchError) throw searchError;
      return (data ?? []) as StockRow[];
    },
    [locationId],
  );

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    // Debounced so typing a SKU does not fire a request per keystroke.
    const timer = setTimeout(() => {
      runSearch(query)
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, runSearch]);

  // --- Basket --------------------------------------------------------------

  const addToBasket = useCallback(
    (row: StockRow) => {
      setError(null);
      setBasket((current) => {
        const existing = current.find((line) => line.variant_id === row.variant_id);

        if (existing) {
          // The database is the real gatekeeper, but stopping here gives the
          // cashier an answer instantly rather than after a failed round trip.
          if (existing.quantity >= row.quantity) {
            setError(t('sale.onlyLeft', { count: row.quantity }));
            return current;
          }
          return current.map((line) =>
            line.variant_id === row.variant_id
              ? { ...line, quantity: line.quantity + 1 }
              : line,
          );
        }

        if (row.quantity <= 0) {
          setError(t('sale.outOfStock'));
          return current;
        }

        return [
          ...current,
          {
            variant_id: row.variant_id,
            sku: row.sku,
            title:
              locale === 'ar' && row.product_title_ar ? row.product_title_ar : row.product_title,
            variant_label: [row.size, row.color].filter(Boolean).join(' / '),
            unit_price_egp: Number(row.price_egp),
            quantity: 1,
            available: row.quantity,
          },
        ];
      });
      setQuery('');
      setResults([]);
      searchBox.current?.focus();
    },
    [locale, t],
  );

  // --- Scanning ------------------------------------------------------------

  const handleScan = useCallback(
    async (code: string) => {
      if (completed) return;
      setError(null);
      try {
        const rows = await runSearch(code);
        // A scan is an exact identifier, so prefer an exact barcode or SKU hit
        // over a fuzzy title match that happens to contain the digits.
        const exact =
          rows.find((row) => row.barcode === code) ??
          rows.find((row) => row.sku.toLowerCase() === code.toLowerCase());

        if (exact) {
          addToBasket(exact);
        } else {
          setQuery(code);
          setResults(rows);
          if (rows.length === 0) setError(t('sale.noResults'));
        }
      } catch {
        setError(t('app.somethingWentWrong'));
      }
    },
    [addToBasket, completed, runSearch, t],
  );

  useBarcodeScanner(handleScan, { enabled: !completed && !submitting });

  const setLineQuantity = (variantId: string, quantity: number) => {
    setBasket((current) =>
      current
        .map((line) =>
          line.variant_id === variantId
            ? { ...line, quantity: Math.max(0, Math.min(quantity, line.available)) }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  };

  const totals = useMemo(
    () => calculateBasket(basket, Number(discount) || 0),
    [basket, discount],
  );

  // --- Completing ----------------------------------------------------------

  async function completeSale() {
    if (!locationId || basket.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      let customerId: string | null = null;
      const phone = normalizeEgyptianPhone(customerPhone);
      const name = customerName.trim();

      // The phone is what identifies a person across channels, so it is what
      // we match on. A name on its own still gets a customer record - a
      // walk-in who gives a name and no number used to be recorded as nobody
      // at all, and the name vanished with them.
      if (phone) {
        const { data: existing } = await supabase
          .from('customers')
          .select('id, full_name')
          .eq('phone', phone)
          .maybeSingle();

        if (existing) {
          customerId = existing.id as string;
          // Fill in a name we did not have before, but never overwrite one:
          // the record may have been corrected by hand since.
          if (name && !existing.full_name) {
            await supabase.from('customers').update({ full_name: name }).eq('id', customerId);
          }
        } else {
          const { data: created } = await supabase
            .from('customers')
            .insert({ phone, full_name: name || null })
            .select('id')
            .single();
          customerId = (created?.id as string | undefined) ?? null;
        }
      } else if (name) {
        const { data: created } = await supabase
          .from('customers')
          .insert({ full_name: name })
          .select('id')
          .single();
        customerId = (created?.id as string | undefined) ?? null;
      }

      const { data, error: rpcError } = await supabase.rpc('create_store_sale', {
        p_location_id: locationId,
        p_payment_method: payment,
        p_items: basket.map((line) => ({
          variant_id: line.variant_id,
          quantity: line.quantity,
        })),
        // Held in a ref, so tapping confirm twice sends the same key and the
        // database returns the first sale instead of selling the stock again.
        p_idempotency_key: idempotencyKey.current,
        p_customer_id: customerId,
        p_discount_egp: Number(discount) || 0,
        p_note: note || null,
        p_channel: channel,
        // Shipping is only offered for something being sent, so a shop sale
        // cannot carry a stale figure left in the box by the previous order.
        p_shipping_egp: channel === 'store' ? 0 : Number(shipping) || 0,
      });

      if (rpcError) {
        // The insufficient_stock hint means another cashier got there first.
        if (/insufficient_stock/i.test(`${rpcError.message} ${rpcError.hint ?? ''}`)) {
          const match = /variant ([0-9a-f-]+)/i.exec(rpcError.message);
          const line = basket.find((l) => l.variant_id === match?.[1]);
          setError(t('sale.insufficient', { sku: line?.sku ?? '' }));
        } else {
          setError(rpcError.message);
        }
        return;
      }

      const order = data as {
        id: string;
        order_number: string;
        total_egp: number;
        created_at: string;
      };

      setCompleted({
        order_id: order.id,
        order_number: order.order_number,
        channel,
        shipping_egp: channel === 'store' ? 0 : Number(shipping) || 0,
        total_egp: Number(order.total_egp),
        payment_method: payment,
        created_at: order.created_at,
        lines: basket,
      });

      // Fast path to Shopify. The outbox already holds these variants, so if
      // this call fails the Worker picks them up within the minute - which is
      // why the result is not awaited or surfaced as an error.
      void supabase.functions
        .invoke('push-inventory', {
          body: {
            variant_ids: basket.map((line) => line.variant_id),
            location_id: locationId,
          },
        })
        .catch(() => undefined);
    } catch {
      setError(t('app.somethingWentWrong'));
    } finally {
      setSubmitting(false);
    }
  }

  function startAnother() {
    setCompleted(null);
    setBasket([]);
    setQuery('');
    setResults([]);
    setNote('');
    setDiscount('');
    setCustomerPhone('');
    setCustomerName('');
    setShipping('');
    setPayment('cash');
    // The channel deliberately survives: someone working through a batch of
    // Instagram orders should not have it snap back to the shop counter
    // between each one, and record the next five against the wrong channel.
    idempotencyKey.current = newIdempotencyKey();
    searchBox.current?.focus();
  }

  // --- Render --------------------------------------------------------------

  // Rendered on its own rather than over the receipt, so a print from the
  // invoice does not also put the thermal receipt through the printer.
  if (completed && showInvoice) {
    return <Invoice orderId={completed.order_id} onClose={() => setShowInvoice(false)} />;
  }

  if (completed) {
    return (
      <div className="space-y-4">
        <Card className="no-print border-emerald-200 bg-emerald-50">
          <p className="text-sm font-bold text-emerald-900">
            {t('sale.success', { orderNumber: completed.order_number })}
          </p>
          <p className="tabular mt-1 text-2xl font-extrabold text-emerald-900">
            {formatEGP(completed.total_egp + completed.shipping_egp, locale)}
          </p>
          {completed.shipping_egp > 0 ? (
            <p className="tabular text-xs text-emerald-800">
              {t('sale.includesShipping', {
                amount: formatEGP(completed.shipping_egp, locale),
              })}
            </p>
          ) : null}

          {/* A shipped order is not finished, and saying "sale recorded" and
              printing a till receipt would suggest it was. It is in the
              packing queue waiting for its confirmation call. */}
          {completed.channel !== 'store' ? (
            <p className="mt-2 text-sm text-emerald-900">{t('sale.queuedForPacking')}</p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            {completed.channel === 'store' ? (
              <Button onClick={() => window.print()}>{t('sale.printReceipt')}</Button>
            ) : null}
            <Button
              variant={completed.channel === 'store' ? 'secondary' : 'primary'}
              onClick={() => setShowInvoice(true)}
            >
              {t('sale.printInvoice')}
            </Button>
            <Button variant="secondary" onClick={startAnother}>
              {t('sale.newSale')}
            </Button>
          </div>
        </Card>

        {/* The thermal receipt is for a customer standing at the counter.
            Nobody is standing there for an Instagram order. */}
        {completed.channel === 'store' ? <Receipt sale={completed} /> : null}
      </div>
    );
  }

  if (!locationId) return <Spinner label={t('app.loading')} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <Card>
          <Field label={t('sale.scanPrompt')}>
            <Input
              ref={searchBox}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sale.searchPlaceholder')}
              inputMode="search"
              autoComplete="off"
            />
          </Field>

          {searching ? <Spinner /> : null}

          {results.length > 0 ? (
            <ul className="mt-3 divide-y divide-duch-line">
              {results.map((row) => (
                <li key={row.variant_id}>
                  <button
                    type="button"
                    onClick={() => addToBasket(row)}
                    disabled={row.quantity <= 0}
                    className="flex w-full items-center gap-3 py-3 text-start disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {locale === 'ar' && row.product_title_ar
                          ? row.product_title_ar
                          : row.product_title}
                      </span>
                      <span className="tabular block text-xs text-stone-500">
                        {row.sku}
                        {row.size || row.color
                          ? ` · ${[row.size, row.color].filter(Boolean).join(' / ')}`
                          : ''}
                      </span>
                    </span>
                    <span className="tabular text-sm font-semibold">
                      {formatEGP(Number(row.price_egp), locale)}
                    </span>
                    <Badge tone={row.quantity <= 0 ? 'bad' : row.quantity <= 3 ? 'warn' : 'good'}>
                      {row.quantity <= 0
                        ? t('sale.outOfStock')
                        : t('sale.inStock', { count: row.quantity })}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {query.trim().length >= 2 && !searching && results.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">{t('sale.noResults')}</p>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-bold">{t('sale.basket')}</h2>
          {basket.length === 0 ? (
            <EmptyState title={t('sale.emptyBasket')} />
          ) : (
            <ul className="divide-y divide-duch-line">
              {basket.map((line) => (
                <li key={line.variant_id} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{line.title}</span>
                    <span className="tabular block text-xs text-stone-500">
                      {line.sku}
                      {line.variant_label ? ` · ${line.variant_label}` : ''}
                    </span>
                  </span>

                  <span className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      className="min-h-9 w-9 px-0"
                      onClick={() => setLineQuantity(line.variant_id, line.quantity - 1)}
                      aria-label="-"
                    >
                      −
                    </Button>
                    <span className="tabular w-8 text-center text-sm font-bold">
                      {line.quantity}
                    </span>
                    <Button
                      variant="secondary"
                      className="min-h-9 w-9 px-0"
                      disabled={line.quantity >= line.available}
                      onClick={() => setLineQuantity(line.variant_id, line.quantity + 1)}
                      aria-label="+"
                    >
                      +
                    </Button>
                  </span>

                  <span className="tabular w-24 text-end text-sm font-semibold">
                    {formatEGP(line.unit_price_egp * line.quantity, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* The till panel. Sticky on desktop so the total stays visible while
          the basket grows past the fold. */}
      <Card className="h-fit lg:sticky lg:top-20">
        <div className="space-y-3">
          {/* Where the order came from. This decides far more than it looks:
              a shop sale is finished when it is rung up, while anything else
              has to be confirmed, packed and shipped, so it starts at the
              front of the packing queue. */}
          <Field label={t('sale.channel')}>
            <Select
              value={channel}
              onChange={(event) => setChannel(event.target.value as OrderChannel)}
            >
              {ORDER_CHANNELS.map((option) => (
                <option key={option} value={option}>
                  {t(`channel.${option}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('sale.paymentMethod')}>
            <Select
              value={payment}
              onChange={(event) => setPayment(event.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`payment.${method}`)}
                </option>
              ))}
            </Select>
          </Field>

          {/* Two boxes, not one. The single box only ever read a phone
              number: type a name into it and the name was silently thrown
              away, along with the customer record. */}
          <Field label={t('sale.customerName')}>
            <Input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder={t('sale.customerNamePlaceholder')}
              autoComplete="off"
            />
          </Field>

          <Field label={t('sale.customerPhone')} hint={t('sale.customerPhoneHint')}>
            <Input
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value)}
              placeholder="01xxxxxxxxx"
              inputMode="tel"
              autoComplete="off"
              dir="ltr"
            />
          </Field>

          {/* Shipping only means anything for something being sent. */}
          {channel !== 'store' ? (
            <Field label={t('sale.shipping')}>
              <Input
                value={shipping}
                onChange={(event) => setShipping(event.target.value)}
                inputMode="decimal"
                placeholder="0"
                className="tabular"
              />
            </Field>
          ) : null}

          <Field label={t('sale.discount')}>
            <Input
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="tabular"
            />
          </Field>

          <Field label={t('sale.note')}>
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>

          <dl className="space-y-1 border-t border-duch-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-stone-600">{t('sale.subtotal')}</dt>
              <dd className="tabular font-semibold">{formatEGP(totals.subtotal_egp, locale)}</dd>
            </div>
            {totals.discount_egp > 0 ? (
              <div className="flex justify-between">
                <dt className="text-stone-600">{t('sale.discount')}</dt>
                <dd className="tabular font-semibold">
                  −{formatEGP(totals.discount_egp, locale)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-duch-line pt-2 text-base">
              <dt className="font-bold">{t('sale.total')}</dt>
              <dd className="tabular font-extrabold">{formatEGP(totals.total_egp, locale)}</dd>
            </div>
          </dl>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <Button
            className="w-full"
            disabled={basket.length === 0 || submitting}
            onClick={completeSale}
          >
            {submitting ? t('sale.completing') : t('sale.complete')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
