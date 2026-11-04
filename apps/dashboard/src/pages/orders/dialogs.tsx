import { useState } from 'react';
import { PAYMENT_METHODS, type PaymentMethod } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { useLocale } from '../../i18n';
import { Button, ErrorNote, Field, Input, Modal, Select } from '../../components/ui';
import type { OrderRow } from './model';

/**
 * Taking back "delivered" pressed by mistake: the order goes back to the
 * courier or driver it was with. If it really came back, it is checked in on
 * Returns after this, like any refused parcel.
 */
export function UndoDeliveredDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('undo_delivered', {
      p_order_id: order.id,
      p_reason: reason.trim() || null,
    });
    setBusy(false);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onDone();
  }

  return (
    <Modal open title={t('orders.undoDeliveredTitle', { orderNumber: order.order_number })} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {t('orders.undoDeliveredHelp')}
          {order.items.some((item) => Number(item.coming_back) > 0) ? ` ${t('orders.undoPartialNote')}` : null}
        </p>

        <Field label={t('orders.undoDeliveredReason')}>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('app.loading') : t('orders.undoDelivered')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Owner only - the database refuses anyone else. For a payment recorded by
 * mistake, which the ordinary editor cannot touch once the order is paid.
 */
export function ReopenPaymentDialog({
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
      setError(rpcError.hint === 'order_on_settlement' ? t('orders.reopenOnStatement') : arabicError(rpcError));
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
