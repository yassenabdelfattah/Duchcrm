import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatEGP } from '@duch/shared';
import { useLocale } from '../../i18n';
import { Button, Code, StatusPill, cx } from '../../components/ui';
import { isClosed, payable, sinceLabel, whereNow, type OrderRow, type SettleAction } from './model';

/** One order, as a line: who, where it stands, what it owes, and its next step as a button. */
export function OrderLine({
  row,
  step,
  busy,
  selectable,
  selected,
  expanded,
  onSelect,
  onToggle,
  onStep,
  children,
}: {
  row: OrderRow;
  step: { rpc: SettleAction; label: string } | null;
  busy: boolean;
  selectable: boolean;
  selected: boolean;
  expanded: boolean;
  onSelect: (on: boolean) => void;
  onToggle: () => void;
  onStep: (rpc: SettleAction) => void;
  children?: ReactNode;
}) {
  const { t, locale } = useLocale();
  const where = whereNow(row, t);
  const owesNothing = isClosed(row) && row.payment_status === 'pending';

  return (
    <li className={cx('border-b border-duch-line last:border-b-0', selected && 'bg-sky-50/60', expanded && 'bg-stone-50/80')}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-stone-50"
      >
        {selectable ? (
          <input
            type="checkbox"
            className="size-5 shrink-0 accent-duch-ink"
            checked={selected}
            aria-label={t('orders.bulk.selectOne', { orderNumber: row.order_number })}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onSelect(event.target.checked)}
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Code className="shrink-0 font-extrabold">{row.order_number}</Code>
            <span className="truncate text-sm">
              <bdi>{row.customer_name ?? t('queue.walkIn')}</bdi>
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-600">
            <StatusPill tone={where.tone}>{where.label}</StatusPill>
            {row.stage !== 'cancelled' ? <span>{sinceLabel(row.stage_since, t)}</span> : null}
            {owesNothing ? null : row.payment_status === 'paid' ? (
              <span className="font-semibold text-emerald-700">{t('paymentStatus.paid')}</span>
            ) : row.payment_status === 'pending' ? (
              <span className="font-semibold text-amber-700">{t('paymentStatus.pending')}</span>
            ) : (
              <span>{t(`paymentStatus.${row.payment_status}`)}</span>
            )}
            {row.exchange_for_order_number ? (
              <span className="font-semibold text-sky-800">{t('exchange.badge')}</span>
            ) : null}
            {row.shopify_pending ? <span className="text-amber-700">{t('orders.shopifyPending')}</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="tabular text-sm font-extrabold">{formatEGP(payable(row), locale)}</span>
          {step ? (
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onStep(step.rpc);
              }}
            >
              {busy ? t('app.loading') : step.label}
            </Button>
          ) : null}
        </div>

        <ChevronDown
          className={cx('size-4 shrink-0 text-stone-400 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </div>

      {expanded && children ? <div className="border-t border-duch-line bg-stone-50/50 px-3 pb-4 pt-3">{children}</div> : null}
    </li>
  );
}
