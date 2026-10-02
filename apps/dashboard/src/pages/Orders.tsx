import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAYMENT_METHODS,
  can,
  calculateInvoiceTotals,
  formatDateTime,
  formatEGP,
  type PaymentMethod,
} from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { supabase } from '../lib/supabase';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
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
import { Invoice } from '../components/Invoice';
import { OrderEditor } from '../components/OrderEditor';

/**
 * Every order, findable.
 *
 * Until this screen existed an order could only be reached while it was in
 * the packing queue or in the seconds after it was rung up. A customer
 * ringing back a week later about a receipt could not be helped at all, and
 * a tab could be started but never settled.
 */

interface OrderRow {
  id: string;
  order_number: string;
  channel: string;
  created_at: string;
  fulfillment_status: string;
  payment_status: string;
  payment_method: string | null;
  total_egp: number;
  shipping_egp: number;
  subtotal_egp: number;
  discount_egp: number;
  cancelled_at: string | null;
  note: string | null;
  customer_id: string | null;
  customers: { full_name: string | null; phone: string | null } | null;
  // An order can be shipped more than once - sent, refused, sent again - so
  // this is a list, newest first, and the current code is the first of them.
  shipments: Array<{
    tracking_number: string | null;
    status: string | null;
    courier: string | null;
    driver_name: string | null;
    direction: string | null;
    created_at: string;
  }>;
}

const PAGE_SIZE = 50;

/**
 * Nothing more is owed on an order that was cancelled or whose goods came
 * back. The database refuses to mark either paid; the payment status of a
 * returned courier parcel stays unpaid only so its statement line is still
 * expected.
 */
function isClosed(row: { cancelled_at: string | null; fulfillment_status: string }): boolean {
  return (
    row.cancelled_at !== null ||
    row.fulfillment_status === 'returned' ||
    row.fulfillment_status === 'return_in_transit'
  );
}

export function Orders() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const maySettle = can(identity?.role, 'sales.create');

  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrderRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reopening, setReopening] = useState<OrderRow | null>(null);

  const load = useCallback(async (term: string) => {
    let query = supabase
      .from('orders')
      .select(
        'id, order_number, channel, created_at, fulfillment_status, payment_status,' +
          ' payment_method, total_egp, shipping_egp, subtotal_egp, discount_egp, cancelled_at,' +
          ' note, customer_id,' +
          ' customers ( full_name, phone ),' +
          ' shipments ( tracking_number, status, courier, driver_name, direction, created_at )',
      )
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);

    const trimmed = term.trim();
    if (trimmed) {
      // Order number or courier tracking code - the two numbers anyone
      // actually quotes down the phone.
      //
      // Tracking needs its own query first. PostgREST will not accept an
      // embedded column inside `or`: it answers "failed to parse logic tree"
      // and returns nothing, which looks exactly like "no such order". So
      // the shipments are matched separately and folded in by id.
      const escaped = trimmed.replace(/[%,()]/g, '');

      const { data: shipmentMatches } = await supabase
        .from('shipments')
        .select('order_id')
        .ilike('tracking_number', `%${escaped}%`)
        .not('order_id', 'is', null)
        .limit(PAGE_SIZE);

      const matchedOrderIds = (shipmentMatches ?? [])
        .map((row) => row.order_id as string)
        .filter(Boolean);

      query = matchedOrderIds.length
        ? query.or(`order_number.ilike.%${escaped}%,id.in.(${matchedOrderIds.join(',')})`)
        : query.ilike('order_number', `%${escaped}%`);
    }

    const { data, error: queryError } = await query;

    if (queryError) {
      setError(queryError.message);
      return;
    }
    setError(null);
    setRows((data ?? []) as unknown as OrderRow[]);
  }, []);

  useEffect(() => {
    // Debounced, so typing an order number does not fire a query per key.
    const timer = setTimeout(() => void load(search), 250);
    return () => clearTimeout(timer);
  }, [search, load]);

  async function settle(
    row: OrderRow,
    rpc: 'mark_order_paid' | 'complete_own_delivery' = 'mark_order_paid',
  ) {
    setBusyId(row.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc(rpc, { p_order_id: row.id });
    setBusyId(null);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    await load(search);
  }

  const unpaidTotal = useMemo(
    () =>
      (rows ?? [])
        .filter((row) => row.payment_status === 'pending' && !isClosed(row))
        .reduce((sum, row) => sum + calculateInvoiceTotals(row).payable_egp, 0),
    [rows],
  );

  if (invoiceId) return <Invoice orderId={invoiceId} onClose={() => setInvoiceId(null)} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-extrabold">{t('orders.title')}</h1>
        {unpaidTotal > 0 ? (
          <span className="tabular rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">
            {t('orders.owed', { amount: formatEGP(unpaidTotal, locale) })}
          </span>
        ) : null}
      </div>

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('orders.searchPlaceholder')}
        autoComplete="off"
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {editing ? (
        <OrderEditor
          order={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load(search)}
        />
      ) : null}

      {reopening ? (
        <ReopenPaymentDialog
          order={reopening}
          onClose={() => setReopening(null)}
          onDone={() => {
            setReopening(null);
            void load(search);
          }}
        />
      ) : null}

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('orders.empty')} />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const totals = calculateInvoiceTotals(row);
            const cancelled = row.cancelled_at !== null;
            // Cancelled, or the goods came back: nothing is owed on it.
            const closed = isClosed(row);
            const tracking = row.shipments?.find((s) => s.tracking_number)?.tracking_number ?? null;
            // Out with one of our own drivers: "cash received" records it
            // delivered and paid in one step, so it replaces mark paid there.
            const withOurDriver = [...(row.shipments ?? [])]
              .filter((s) => s.direction === 'outbound')
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
            const deliverable =
              maySettle &&
              !cancelled &&
              withOurDriver?.courier === 'own' &&
              withOurDriver.status === 'out_for_delivery';
            // Every unpaid order but card, which is paid at the till - the
            // owner's decision, cash on delivery included.
            const settleable =
              maySettle &&
              !closed &&
              !deliverable &&
              row.payment_status === 'pending' &&
              row.payment_method !== 'card';

            return (
              <Card key={row.id} className="space-y-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0">
                    <p className="tabular font-extrabold" dir="ltr">
                      {row.order_number}
                    </p>
                    <p className="text-xs text-stone-500">
                      {formatDateTime(row.created_at, locale)}
                    </p>
                    {tracking ? (
                      <p className="tabular text-xs font-semibold text-stone-700" dir="ltr">
                        {tracking}
                      </p>
                    ) : withOurDriver?.courier === 'own' && withOurDriver.driver_name ? (
                      <p className="text-xs font-semibold text-stone-700">
                        {t('queue.withDriver', { name: withOurDriver.driver_name })}
                      </p>
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <bdi>{row.customers?.full_name ?? '—'}</bdi>
                    </p>
                    {row.customers?.phone ? (
                      <p className="tabular text-xs text-stone-500" dir="ltr">
                        {row.customers.phone}
                      </p>
                    ) : null}
                  </div>

                  <div className="text-end">
                    <p className="tabular font-extrabold">
                      {formatEGP(totals.payable_egp, locale)}
                    </p>
                    {totals.shipping_egp > 0 ? (
                      <p className="tabular text-xs text-stone-500">
                        {t('sale.includesShipping', {
                          amount: formatEGP(totals.shipping_egp, locale),
                        })}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{t(`channel.${row.channel}`)}</Badge>
                  <Badge tone={cancelled ? 'bad' : 'neutral'}>
                    {cancelled
                      ? t('orders.cancelled')
                      : t(`fulfillment.${row.fulfillment_status}`)}
                  </Badge>
                  {closed && row.payment_status === 'pending' ? (
                    <Badge>{t('orders.nothingOwed')}</Badge>
                  ) : (
                    <Badge tone={row.payment_status === 'paid' ? 'good' : 'warn'}>
                      {t(`paymentStatus.${row.payment_status}`)}
                    </Badge>
                  )}
                  {row.payment_method ? (
                    <span className="text-xs text-stone-500">
                      {t(`payment.${row.payment_method}`)}
                    </span>
                  ) : null}

                  {/* Editing is offered even on a locked order: the customer's
                      name and the note are still correctable, and the editor
                      says which parts are fixed. */}
                  {maySettle && !cancelled ? (
                    <Button
                      variant="secondary"
                      className="ms-auto"
                      onClick={() => setEditing(row)}
                    >
                      {t('orders.edit')}
                    </Button>
                  ) : null}

                  <Button
                    variant="secondary"
                    className={maySettle && !cancelled ? undefined : 'ms-auto'}
                    onClick={() => setInvoiceId(row.id)}
                  >
                    {t('sale.printInvoice')}
                  </Button>

                  {settleable ? (
                    <Button disabled={busyId === row.id} onClick={() => void settle(row)}>
                      {busyId === row.id ? t('app.loading') : t('orders.markPaid')}
                    </Button>
                  ) : null}

                  {/* Owner only - the database refuses anyone else. For a
                      payment recorded by mistake, which the ordinary editor
                      cannot touch once the order is paid. */}
                  {identity?.is_owner && !cancelled && row.payment_status === 'paid' ? (
                    <Button variant="secondary" onClick={() => setReopening(row)}>
                      {t('orders.reopenPayment')}
                    </Button>
                  ) : null}

                  {deliverable ? (
                    <Button
                      disabled={busyId === row.id}
                      onClick={() => void settle(row, 'complete_own_delivery')}
                    >
                      {busyId === row.id
                        ? t('app.loading')
                        : row.payment_method === 'cod'
                          ? t('queue.cashReceived')
                          : t('queue.delivered')}
                    </Button>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Reopening a payment recorded by mistake ---------------------------------

function ReopenPaymentDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [method, setMethod] = useState<PaymentMethod>(
    (order.payment_method as PaymentMethod | null) ?? 'deferred',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason.trim()) {
      setError(t('orders.reopenReasonRequired'));
      return;
    }

    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('reopen_order_payment', {
      p_order_id: order.id,
      p_payment_method: method,
      p_reason: reason.trim(),
    });
    setBusy(false);

    if (rpcError) {
      setError(rpcError.hint === 'order_on_settlement' ? t('orders.reopenOnStatement') : rpcError.message);
      return;
    }
    onDone();
  }

  return (
    <Modal open title={t('orders.reopenTitle', { orderNumber: order.order_number })} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{t('orders.reopenHelp')}</p>

        <Field label={t('orders.reopenMethod')}>
          <Select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((value) => (
              <option key={value} value={value}>
                {t(`payment.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('orders.reopenReason')}>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('app.loading') : t('orders.reopenPayment')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
