import { useCallback, useEffect, useMemo, useState } from 'react';
import { can, calculateInvoiceTotals, formatDateTime, formatEGP } from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { supabase } from '../lib/supabase';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Spinner } from '../components/ui';
import { Invoice } from '../components/Invoice';

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
  customers: { full_name: string | null; phone: string | null } | null;
}

const PAGE_SIZE = 50;

export function Orders() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const maySettle = can(identity?.role, 'sales.create');

  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (term: string) => {
    let query = supabase
      .from('orders')
      .select(
        'id, order_number, channel, created_at, fulfillment_status, payment_status,' +
          ' payment_method, total_egp, shipping_egp, subtotal_egp, discount_egp, cancelled_at,' +
          ' customers ( full_name, phone )',
      )
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);

    const trimmed = term.trim();
    if (trimmed) {
      // Order number only. Searching the customer's name or number means
      // filtering on an embedded table, which PostgREST will not do from
      // here - the orders screen would have to query customers first. The
      // number is what people quote down the phone anyway.
      const escaped = trimmed.replace(/[%,]/g, '');
      query = query.ilike('order_number', `%${escaped}%`);
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

  async function settle(row: OrderRow) {
    setBusyId(row.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc('mark_order_paid', { p_order_id: row.id });
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
        .filter((row) => row.payment_status === 'pending' && !row.cancelled_at)
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

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('orders.empty')} />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const totals = calculateInvoiceTotals(row);
            const cancelled = row.cancelled_at !== null;
            // Cash on delivery becomes paid when its settlement is reviewed,
            // never here - the database refuses it, so the button is not
            // offered either.
            const settleable =
              maySettle &&
              !cancelled &&
              row.payment_status === 'pending' &&
              row.payment_method !== 'cod';

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
                  <Badge tone={row.payment_status === 'paid' ? 'good' : 'warn'}>
                    {t(`paymentStatus.${row.payment_status}`)}
                  </Badge>
                  {row.payment_method ? (
                    <span className="text-xs text-stone-500">
                      {t(`payment.${row.payment_method}`)}
                    </span>
                  ) : null}

                  <Button
                    variant="secondary"
                    className="ms-auto"
                    onClick={() => setInvoiceId(row.id)}
                  >
                    {t('sale.printInvoice')}
                  </Button>

                  {settleable ? (
                    <Button disabled={busyId === row.id} onClick={() => void settle(row)}>
                      {busyId === row.id ? t('app.loading') : t('orders.markPaid')}
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
