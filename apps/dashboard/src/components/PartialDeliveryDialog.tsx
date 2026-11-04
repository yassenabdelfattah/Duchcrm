import { useEffect, useMemo, useState } from 'react';
import { formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { useLocale } from '../i18n';
import { Button, ErrorNote, Field, Input, Modal, Spinner, cx } from './ui';

/**
 * Delivered in part: the customer kept some of the parcel and handed the rest
 * back to the courier (the owner, 2026-11-04). Asks, piece by piece, what was
 * taken and what is coming back, and why. The database delivers the order of
 * what was kept and opens a refusal for the rest, which Returns then shows
 * coming back; the refused pieces come off what is owed at once.
 */

/** Why the pieces came back at the door: the refusals that fit a parcel the customer took part of. */
const REASONS = ['refused_after_inspection', 'wrong_size', 'not_as_expected', 'faulty', 'wrong_item_sent'] as const;

interface OrderLine {
  order_line_item_id: string;
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_value_egp: number;
}

export interface PartialDeliveryOrder {
  id: string;
  order_number: string;
  courier: string | null;
  stage: string;
  payment_status: string;
  shipping_egp: number;
  cod_amount_egp?: number | null;
}

export function PartialDeliveryDialog({
  order,
  onClose,
  onDone,
}: {
  order: PartialDeliveryOrder;
  onClose: () => void;
  onDone: (summary: { kept: number; back: number }) => void;
}) {
  const { t, locale } = useLocale();
  const [lines, setLines] = useState<OrderLine[] | null>(null);
  // How many of each line the customer took; all of it to start with, so
  // marking the one refused piece is one tap.
  const [kept, setKept] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<(typeof REASONS)[number]>('refused_after_inspection');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    supabase.rpc('order_lines_json', { p_order_id: order.id }).then(({ data, error: rpcError }) => {
      if (!current) return;
      if (rpcError) {
        setError(arabicError(rpcError));
        setLines([]);
        return;
      }
      const rows = ((data ?? []) as OrderLine[]).map((line) => ({
        ...line,
        quantity: Number(line.quantity),
        unit_value_egp: Number(line.unit_value_egp),
      }));
      setLines(rows);
      setKept(Object.fromEntries(rows.map((line) => [line.order_line_item_id, line.quantity])));
    });
    return () => {
      current = false;
    };
  }, [order.id]);

  const totals = useMemo(() => {
    let keptPieces = 0;
    let backPieces = 0;
    let keptValue = 0;
    let backValue = 0;
    for (const line of lines ?? []) {
      const took = kept[line.order_line_item_id] ?? line.quantity;
      keptPieces += took;
      backPieces += line.quantity - took;
      keptValue += took * line.unit_value_egp;
      backValue += (line.quantity - took) * line.unit_value_egp;
    }
    return { keptPieces, backPieces, keptValue, backValue };
  }, [lines, kept]);

  // Paid online before it left: what comes back is owed to the customer.
  // Otherwise the customer paid at the door for what they kept, and the
  // shipping.
  const prepaid = order.payment_status === 'paid' && Number(order.cod_amount_egp ?? 0) === 0;
  const ownDriver = order.courier === 'own';
  const ready = totals.keptPieces > 0 && totals.backPieces > 0;

  function setTook(line: OrderLine, value: number) {
    setKept((current) => ({ ...current, [line.order_line_item_id]: Math.max(0, Math.min(line.quantity, value)) }));
  }

  async function submit() {
    if (!lines || !ready) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('record_partial_delivery', {
      p_order_id: order.id,
      p_lines: lines.map((line) => ({
        order_line_item_id: line.order_line_item_id,
        quantity_kept: kept[line.order_line_item_id] ?? line.quantity,
      })),
      p_reason: reason,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onDone({ kept: totals.keptPieces, back: totals.backPieces });
  }

  return (
    <Modal open title={t('orders.partialTitle', { orderNumber: order.order_number })} onClose={busy ? () => undefined : onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">{t('orders.partialHelp')}</p>

        {lines === null ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <ul className="divide-y divide-duch-line">
            {lines.map((line) => {
              const took = kept[line.order_line_item_id] ?? line.quantity;
              return (
                <li key={line.order_line_item_id} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        <bdi>{[line.title, line.variant_title].filter(Boolean).join(' · ')}</bdi>
                      </span>
                      <span className="tabular block text-xs text-stone-500" dir="ltr">
                        {line.sku}
                      </span>
                    </span>
                    <span className="tabular text-xs text-stone-500">
                      {t('returns.expectedQty')} {line.quantity}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <Stepper
                      label={t('orders.partialTook')}
                      value={took}
                      max={line.quantity}
                      onChange={(value) => setTook(line, value)}
                    />
                    <Stepper
                      label={t('orders.partialBack')}
                      value={line.quantity - took}
                      max={line.quantity}
                      onChange={(value) => setTook(line, line.quantity - value)}
                      tone="warn"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold text-stone-600">{t('orders.partialReason')}</p>
          <div className="grid grid-cols-2 gap-2">
            {REASONS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setReason(value)}
                className={cx(
                  'min-h-11 rounded-lg border px-3 text-start text-xs font-semibold transition-colors',
                  reason === value
                    ? 'border-duch-ink bg-duch-ink text-white'
                    : 'border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                )}
              >
                {t(`returnReason.${value}`)}
              </button>
            ))}
          </div>
        </div>

        <Field label={t('queue.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {/* The money, before it is confirmed. */}
        {lines && lines.length > 0 ? (
          ready ? (
            <div className="tabular space-y-1 rounded-lg bg-stone-50 px-3 py-2 text-sm">
              <p>{t('orders.partialOffBill', { amount: formatEGP(totals.backValue, locale) })}</p>
              <p className="font-bold">
                {prepaid
                  ? t('orders.partialRefund', { amount: formatEGP(totals.backValue, locale) })
                  : t(ownDriver ? 'orders.partialDriverCash' : 'orders.partialCustomerPays', {
                      amount: formatEGP(totals.keptValue + Number(order.shipping_egp), locale),
                    })}
              </p>
            </div>
          ) : (
            <p className="text-xs text-stone-500">{t('orders.partialPickBack')}</p>
          )
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={() => void submit()} disabled={busy || !ready}>
            {busy ? t('app.loading') : t('orders.partialConfirm')}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Stepper({
  label,
  value,
  max,
  onChange,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
  tone?: 'warn';
}) {
  return (
    <div>
      <span className="mb-1 block text-xs font-semibold text-stone-600">{label}</span>
      <div className="flex items-center gap-1">
        <Button variant="secondary" className="min-h-11 w-11 px-0" disabled={value <= 0} onClick={() => onChange(value - 1)} aria-label="-">
          −
        </Button>
        <span className={cx('tabular w-10 text-center text-lg font-extrabold', tone === 'warn' && value > 0 && 'text-amber-600')}>
          {value}
        </span>
        <Button variant="secondary" className="min-h-11 w-11 px-0" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="+">
          +
        </Button>
      </div>
    </div>
  );
}
