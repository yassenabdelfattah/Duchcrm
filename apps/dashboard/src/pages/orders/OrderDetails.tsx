import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { calculateInvoiceTotals, formatDateTime, formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { useLocale } from '../../i18n';
import { Badge, Button, Code, StatusPill } from '../../components/ui';
import { CustomerSignals, type CustomerSignalsData } from '../../components/CustomerSignals';
import {
  RETURNABLE,
  courierName,
  isClosed,
  payable,
  stepsFor,
  type OrderRow,
  type Permissions,
  type SettleAction,
} from './model';

/** An order opened from its line: everything about it, and every step it offers. */
export function OrderDetails({
  row,
  busy,
  perms,
  onHistory,
  onEdit,
  onInvoice,
  onSettle,
  onReopen,
  onUndoDelivered,
  onPartial,
  onCancel,
  onExchange,
}: {
  row: OrderRow;
  busy: boolean;
  perms: Permissions;
  onHistory: () => void;
  onEdit: () => void;
  onInvoice: () => void;
  onSettle: (rpc: SettleAction) => void;
  onReopen: () => void;
  onUndoDelivered: () => void;
  onPartial: () => void;
  onCancel: () => void;
  onExchange: () => void;
}) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const totals = calculateInvoiceTotals(row);
  const { cancelled, deliverable, courierDelivered, settleable } = stepsFor(row, perms);
  // Cancelled, or the goods came back: nothing is owed on it.
  const closed = isClosed(row);
  // The customer kept part of the parcel: while it is with the courier or our
  // driver, or once marked delivered with nothing back on it yet. Our
  // driver's brings his cash in, so it is for the people who record cash. An
  // exchange's parcel also carries the old piece, so it is said on Returns.
  const pieceBack = row.items.some((item) => Number(item.returned) > 0 || Number(item.coming_back) > 0);
  const partialable =
    !cancelled &&
    row.courier !== null &&
    Number(row.unit_count) > 1 &&
    !row.exchange_for_order_id &&
    !pieceBack &&
    ((row.stage === 'on_the_road' && (row.courier === 'own' ? perms.maySettle : perms.mayDeliver)) ||
      (row.stage === 'delivered' && perms.mayDeliver));

  // The person's record and the number's other names. Read for the order
  // that is open, not for every row of the list.
  const [signals, setSignals] = useState<CustomerSignalsData | null>(null);
  useEffect(() => {
    let current = true;
    setSignals(null);
    supabase.rpc('order_customer_signals', { p_order_id: row.id }).then(({ data }) => {
      if (current) setSignals((data as CustomerSignalsData | null) ?? null);
    });
    return () => {
      current = false;
    };
  }, [row.id]);

  return (
    <div className="space-y-3">
      {/* Where it came from, when, and how it is paid. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
        <Badge>{t(`channel.${row.channel}`)}</Badge>
        <span>{formatDateTime(row.created_at, locale)}</span>
        {closed && row.payment_status === 'pending' ? (
          <StatusPill tone="closed">{t('orders.nothingOwed')}</StatusPill>
        ) : (
          <StatusPill tone={row.payment_status === 'paid' ? 'done' : 'wait'}>
            {t(`paymentStatus.${row.payment_status}`)}
          </StatusPill>
        )}
        {row.payment_method ? <span>{t(`payment.${row.payment_method}`)}</span> : null}
      </div>
      {row.exchange_for_order_number ? (
        <p className="text-xs font-semibold text-sky-800">
          {t('exchange.forOrder', { orderNumber: row.exchange_for_order_number })}
        </p>
      ) : null}
      {row.exchanged_in ? (
        <p className="text-xs text-sky-800">{t('exchange.exchangedIn', { orderNumbers: row.exchanged_in })}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Who and where. */}
        <div className="space-y-0.5 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-duch-line">
          <p className="font-bold">
            <bdi>{row.customer_name ?? t('queue.walkIn')}</bdi>
          </p>
          {row.customer_phone ? (
            <a href={`tel:${row.customer_phone}`} className="block text-duch-accent underline">
              <Code>{row.customer_phone}</Code>
            </a>
          ) : null}
          {row.customer_address ? (
            <p className="text-stone-600">
              <bdi>{row.customer_address}</bdi>
            </p>
          ) : null}
        </div>

        {/* The parcel. The shipment number is the one people read off a
            label, so it is the biggest thing here. */}
        <div className="space-y-0.5 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-duch-line">
          {row.tracking_number ? (
            <>
              <p className="text-xs text-stone-500">
                {t('orders.shipmentWith', { courier: courierName(row, t) })}
              </p>
              <Code className="block text-base font-extrabold">{row.tracking_number}</Code>
            </>
          ) : row.courier === 'own' ? (
            <>
              <p className="text-xs text-stone-500">{t('orders.courier.own')}</p>
              <p className="font-bold">
                <bdi>{row.driver_name ?? '—'}</bdi>
              </p>
            </>
          ) : row.channel === 'store' ? (
            <p className="text-stone-500">{t('orders.pickedUpInStore')}</p>
          ) : (
            <p className="text-stone-500">{t('orders.noShipment')}</p>
          )}
        </div>
      </div>

      <CustomerSignals signals={signals} />

      {/* What they took. */}
      <ul className="divide-y divide-duch-line rounded-lg bg-white text-sm ring-1 ring-duch-line">
        {row.items.map((item, index) => (
          <li key={`${item.sku}:${index}`} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                <bdi>{item.title}</bdi>
              </span>
              <span className="block text-xs text-stone-500">
                {item.variant_title ? <bdi>{item.variant_title}</bdi> : null}
                {item.variant_title ? ' · ' : null}
                <Code>{item.sku}</Code>
              </span>
            </span>
            {Number(item.returned) > 0 ? (
              <StatusPill tone="back">{t('orders.returnedQty', { count: Number(item.returned) })}</StatusPill>
            ) : null}
            {Number(item.coming_back) > 0 ? (
              <StatusPill tone="road">{t('orders.comingBackQty', { count: Number(item.coming_back) })}</StatusPill>
            ) : null}
            <span className="tabular whitespace-nowrap text-stone-600">
              {item.quantity} × {formatEGP(Number(item.unit_price_egp), locale)}
            </span>
          </li>
        ))}
        <li className="tabular flex flex-wrap justify-end gap-x-4 gap-y-1 bg-stone-50 px-3 py-2 text-xs text-stone-600">
          <span>
            {t('orders.goods')} {formatEGP(totals.subtotal_egp, locale)}
          </span>
          {totals.discount_egp > 0 ? (
            <span>
              {row.exchange_for_order_id ? t('exchange.credit') : t('sale.discount')} −
              {formatEGP(totals.discount_egp, locale)}
            </span>
          ) : null}
          <span>
            {t('sale.shipping')} {totals.shipping_egp > 0 ? formatEGP(totals.shipping_egp, locale) : '—'}
          </span>
          {Number(row.returned_off_egp) > 0 ? (
            <span>
              {t('orders.returnedOff')} −{formatEGP(Number(row.returned_off_egp), locale)}
            </span>
          ) : null}
          <span className="font-bold text-duch-ink">
            {t('sale.total')} {formatEGP(payable(row), locale)}
          </span>
        </li>
      </ul>

      {Number(row.exchange_refund_egp) > 0 ? (
        row.exchange_refunded_at ? (
          <p className="text-xs text-stone-500">
            {t('exchange.refunded', { amount: formatEGP(Number(row.exchange_refund_egp), locale) })}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="flex-1 font-bold">
              {t('exchange.owedBack', { amount: formatEGP(Number(row.exchange_refund_egp), locale) })}
            </span>
            {perms.maySettle ? (
              <Button
                variant="secondary"
                className="min-h-9 px-3 text-xs"
                disabled={busy}
                onClick={() => onSettle('mark_exchange_refunded')}
              >
                {t('exchange.markRefunded')}
              </Button>
            ) : null}
          </div>
        )
      ) : null}

      {/* Pieces sent back that the customer had paid for. */}
      {Number(row.return_refund_owed_egp) > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="flex-1 font-bold">
            {t('orders.returnRefundOwed', { amount: formatEGP(Number(row.return_refund_owed_egp), locale) })}
          </span>
          {perms.maySettle ? (
            <Button
              variant="secondary"
              className="min-h-9 px-3 text-xs"
              disabled={busy}
              onClick={() => onSettle('mark_return_refunded')}
            >
              {t('exchange.markRefunded')}
            </Button>
          ) : null}
        </div>
      ) : Number(row.return_refunded_egp) > 0 ? (
        <p className="text-xs text-stone-500">
          {t('orders.returnRefunded', { amount: formatEGP(Number(row.return_refunded_egp), locale) })}
        </p>
      ) : null}

      {row.note ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-bold">{t('orders.noteLabel')}: </span>
          <bdi>{row.note}</bdi>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onHistory}>
          {t('orders.history.open')}
        </Button>
        {/* Editing is offered even on a locked order: the customer's name and
            the note are still correctable, and the editor says which parts
            are fixed. */}
        {perms.mayEdit && !cancelled ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onEdit}>
            {t('orders.edit')}
          </Button>
        ) : null}
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onInvoice}>
          {t('sale.printInvoice')}
        </Button>

        {perms.mayExchange && !cancelled && row.stage === 'delivered' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onExchange}>
            {t('exchange.button')}
          </Button>
        ) : null}

        {/* Opens the returns screen on this order: the reason, what came
            back and in what state are asked there, the same as a scanned
            parcel. */}
        {perms.mayReturn && !cancelled && RETURNABLE.has(row.fulfillment_status) ? (
          <Button
            variant="secondary"
            className="min-h-9 px-3 text-xs"
            onClick={() => navigate(`/returns?q=${encodeURIComponent(row.order_number)}`)}
          >
            {t('orders.return')}
          </Button>
        ) : null}

        {/* Only before it leaves: after that the goods come back through
            returns, not by changing a status. */}
        {perms.mayCancel && !cancelled && row.stage === 'to_ship' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs text-red-700" onClick={onCancel}>
            {t('orders.cancel')}
          </Button>
        ) : null}

        {/* Owner only - the database refuses anyone else. For a payment
            recorded by mistake, which the ordinary editor cannot touch once
            the order is paid. */}
        {perms.isOwner && !cancelled && row.payment_status === 'paid' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onReopen}>
            {t('orders.reopenPayment')}
          </Button>
        ) : null}

        {/* "Delivered" pressed by mistake. The database says no once
            something was built on it - paid with the delivery, a piece back,
            or the courier's statement saying the customer has it. */}
        {perms.mayDeliver && !cancelled && row.fulfillment_status === 'delivered' && row.courier !== null ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onUndoDelivered}>
            {t('orders.undoDelivered')}
          </Button>
        ) : null}

        {partialable ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onPartial}>
            {t('orders.partialDelivery')}
          </Button>
        ) : null}

        {settleable ? (
          <Button className="ms-auto" disabled={busy} onClick={() => onSettle('mark_order_paid')}>
            {busy ? t('app.loading') : t('orders.markPaid')}
          </Button>
        ) : null}

        {courierDelivered ? (
          <Button
            variant="secondary"
            className={settleable ? undefined : 'ms-auto'}
            disabled={busy}
            onClick={() => onSettle('mark_courier_delivered')}
          >
            {busy ? t('app.loading') : t('orders.customerReceived')}
          </Button>
        ) : null}

        {deliverable ? (
          <Button className="ms-auto" disabled={busy} onClick={() => onSettle('complete_own_delivery')}>
            {busy
              ? t('app.loading')
              : row.payment_method === 'cod'
                ? t('queue.cashReceived')
                : t('queue.delivered')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
