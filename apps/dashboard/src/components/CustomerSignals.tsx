import { isolate, useLocale } from '../i18n';
import { Badge } from './ui';

/** What order_customer_signals says about who an order ships to. */
export interface CustomerSignalsData {
  refused: number;
  received: number;
  /** Taken after the last refusal: the refusal was made good. */
  received_since_refusal: number;
  history: Array<{
    order_number: string;
    outcome: 'refused' | 'received';
    /** How the order was tied to this one. A name alone is the weakest tie. */
    via: 'customer' | 'phone' | 'name';
    name: string | null;
    phone: string | null;
  }>;
  /** Names this order's number went under that are not this order's name. */
  other_names: Array<{ name: string; orders: string[] }>;
}

/**
 * The person's record and the number's other names - the things worth knowing
 * before spending a courier run.
 *
 * A refusal is shown with what came after it: #1442's customer refused it,
 * then took and paid for W2610-00049 on another number, and "refused once
 * before" alone said the opposite of what happened. An order tied by name alone says so, with
 * its number, so whoever reads it can judge the tie.
 */
export function CustomerSignals({ signals }: { signals: CustomerSignalsData | null | undefined }) {
  const { t } = useLocale();
  if (!signals) return null;

  const { refused, received, received_since_refusal: madeGood, history, other_names: otherNames } = signals;
  if (refused === 0 && received === 0 && otherNames.length === 0) return null;

  const withOrders = otherNames.filter((entry) => entry.orders.length > 0);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {refused > 0 && madeGood > 0 ? (
          <Badge tone="warn">{t('signals.refusedThenReceived', { refused, received: madeGood })}</Badge>
        ) : refused > 0 ? (
          <Badge tone="bad">{t('signals.refused', { count: refused })}</Badge>
        ) : received > 0 ? (
          <Badge tone="good">{t('signals.received', { count: received })}</Badge>
        ) : null}
        {otherNames.length > 0 ? (
          <Badge tone="warn">
            {t('signals.otherNames', { names: otherNames.map((entry) => isolate(entry.name)).join('، ') })}
          </Badge>
        ) : null}
      </div>

      {/* Which orders, when it is a refusal: the badge is the verdict, this
          is what it rests on. */}
      {refused > 0 ? (
        <p className="text-xs text-stone-500">
          {history
            .map((entry) =>
              [
                isolate(entry.order_number),
                t(`signals.outcome.${entry.outcome}`),
                entry.via === 'name' ? t('signals.viaName', { phone: entry.phone ?? '—' }) : null,
              ]
                .filter(Boolean)
                .join(' '),
            )
            .join(' · ')}
        </p>
      ) : null}

      {withOrders.length > 0 ? (
        <p className="text-xs text-stone-500">
          {withOrders
            .map((entry) => t('signals.onOrders', { name: entry.name, orders: entry.orders.map(isolate).join('، ') }))
            .join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
