import { useEffect, useState } from 'react';
import { formatDateTime } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { useLocale } from '../../i18n';
import { Code, ErrorNote, Modal, Spinner, StatusPill, cx } from '../../components/ui';
import { courierName, isClosed, sinceLabel, whereNow, type OrderRow, type Translate } from './model';

// --- The tracker: every step, who did it, and when ----------------------------------

interface OrderEvent {
  id: string;
  event_type: string;
  from_fulfillment: string | null;
  to_fulfillment: string | null;
  from_payment: string | null;
  to_payment: string | null;
  note: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  staff: { full_name: string | null } | null;
}

/** One line of history, in words. */
function describeEvent(event: OrderEvent, t: Translate): string {
  switch (event.event_type) {
    case 'created':
      return t('orders.history.created');
    case 'confirmation_call': {
      const outcome = event.details?.outcome as string | undefined;
      return t('orders.history.call', { outcome: outcome ? t(`orders.history.outcome.${outcome}`) : '—' });
    }
    case 'fulfillment_change':
      return event.to_fulfillment
        ? t(`orders.history.to.${event.to_fulfillment}`)
        : t('orders.history.statusChanged');
    case 'payment_change':
      return event.to_payment === 'paid'
        ? t('orders.history.paid')
        : t('orders.history.paymentTo', { status: t(`paymentStatus.${event.to_payment ?? 'pending'}`) });
    case 'payment_reopened':
      return t('orders.history.reopened');
    case 'items_edited':
      return event.details?.source === 'shopify'
        ? t('orders.history.itemsEditedShopify')
        : t('orders.history.itemsEdited');
    case 'shopify_synced':
      if (event.details?.action === 'cancel') return t('orders.history.shopifyCancelled');
      if (event.details?.shipping_updated === false) {
        return event.details?.items_changed
          ? t('orders.history.shopifyItemsNotShipping')
          : t('orders.history.shopifyShippingRefused');
      }
      return t('orders.history.shopifySynced');
    case 'shopify_refund':
      return t('orders.history.shopifyRefund', { amount: String(event.details?.amount_egp ?? '') });
    case 'payment_corrected':
      return t('orders.history.paymentCorrected');
    case 'exchange':
      return t('orders.history.exchange', { orderNumber: String(event.details?.replacement_order_number ?? '') });
    case 'shopify_closed_after_return':
      return t('orders.history.shopifyClosedAfterReturn');
    case 'exchange_refunded':
      return t('orders.history.exchangeRefunded', { amount: String(event.details?.amount_egp ?? '') });
    case 'return_refunded':
      return t('orders.history.returnRefunded', { amount: String(event.details?.amount_egp ?? '') });
    case 'edited':
      return t('orders.history.edited');
    case 'ship_to_edited':
      return t('orders.history.shipToEdited');
    case 'delivery_undone':
      return t('orders.history.deliveryUndone');
    case 'partial_delivery':
      return t('orders.history.partialDelivery', {
        kept: String(event.details?.kept ?? ''),
        back: String(event.details?.back ?? ''),
      });
    default:
      return event.event_type;
  }
}

export function OrderHistory({ order, onClose }: { order: OrderRow; onClose: () => void }) {
  const { t, locale } = useLocale();
  const [events, setEvents] = useState<OrderEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('order_events')
      .select(
        'id, event_type, from_fulfillment, to_fulfillment, from_payment, to_payment, note, details, created_at, staff ( full_name )',
      )
      .eq('order_id', order.id)
      .order('created_at', { ascending: false })
      .then(({ data, error: queryError }) => {
        if (cancelled) return;
        if (queryError) setError(arabicError(queryError));
        else setEvents((data ?? []) as unknown as OrderEvent[]);
      });
    return () => {
      cancelled = true;
    };
  }, [order.id]);

  const where = whereNow(order, t);
  const paid = order.payment_status === 'paid';
  const closed = isClosed(order);
  const bornDelivered = order.channel === 'store';

  // The steps an order goes through, ticked as far as it has got.
  type Step = { label: string; state: 'done' | 'now' | 'todo' | 'problem' };
  const steps: Step[] = bornDelivered
    ? [
        { label: t('orders.step.sold'), state: 'done' },
        {
          label: closed ? t('orders.nothingOwed') : t('orders.step.paid'),
          state: paid ? 'done' : closed ? 'problem' : 'now',
        },
      ]
    : [
        { label: t('orders.step.ordered'), state: 'done' },
        {
          label: t('orders.step.out'),
          state: order.stage === 'to_ship' ? 'now' : order.stage === 'cancelled' ? 'todo' : 'done',
        },
        {
          label: order.stage === 'back' ? t(`fulfillment.${order.fulfillment_status}`) : t('orders.step.delivered'),
          state:
            order.stage === 'delivered'
              ? 'done'
              : order.stage === 'back'
                ? 'problem'
                : order.stage === 'on_the_road'
                  ? 'now'
                  : 'todo',
        },
        {
          label: closed ? t('orders.nothingOwed') : t('orders.step.paid'),
          state: paid ? 'done' : closed ? 'problem' : order.stage === 'delivered' ? 'now' : 'todo',
        },
      ];

  const STEP_BAR: Record<Step['state'], string> = {
    done: 'bg-emerald-600',
    now: 'bg-blue-600 animate-pulse',
    todo: 'bg-duch-line',
    problem: 'bg-red-500',
  };

  return (
    <Modal open title={t('orders.history.title', { orderNumber: order.order_number })} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
          <StatusPill tone={where.tone}>{where.label}</StatusPill>
          {order.stage !== 'cancelled' ? <span>{sinceLabel(order.stage_since, t)}</span> : null}
        </div>

        <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((step) => (
            <li key={step.label} className="space-y-1">
              <span className={cx('block h-1.5 rounded-full', STEP_BAR[step.state])} />
              <span
                className={cx(
                  'block text-xs font-semibold',
                  step.state === 'todo' ? 'text-stone-400' : 'text-duch-ink',
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>

        {order.tracking_number || order.courier === 'own' ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <p className="text-xs text-stone-500">{t('orders.shipmentWith', { courier: courierName(order, t) })}</p>
              {order.tracking_number ? (
                <Code className="font-bold">{order.tracking_number}</Code>
              ) : (
                <p className="font-bold">—</p>
              )}
            </div>
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <p className="text-xs text-stone-500">{t('orders.handedOver')}</p>
              <p className="tabular font-bold">
                {order.handed_over_at ? formatDateTime(order.handed_over_at, locale) : '—'}
              </p>
            </div>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {!events ? (
          <Spinner />
        ) : (
          <ol className="relative space-y-3 border-s-2 border-duch-line ps-4">
            {events.map((event) => (
              <li key={event.id} className="relative">
                <span className="absolute -start-[1.4rem] top-1.5 size-2.5 rounded-full bg-duch-ink ring-4 ring-white" />
                <p className="text-sm font-semibold">{describeEvent(event, t)}</p>
                {event.note ? (
                  <p className="text-xs text-stone-600">
                    <bdi>{event.note}</bdi>
                  </p>
                ) : null}
                <p className="text-xs text-stone-500">
                  {formatDateTime(event.created_at, locale)}
                  {event.staff?.full_name ? (
                    <>
                      {' · '}
                      <bdi>{event.staff.full_name}</bdi>
                    </>
                  ) : (
                    <> · {t('orders.history.system')}</>
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}
