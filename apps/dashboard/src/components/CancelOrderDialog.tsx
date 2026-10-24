import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { sendOrderToShopify } from '../lib/shopifySync';
import { useLocale } from '../i18n';
import { Button, ErrorNote, Field, Input, Modal } from './ui';

/**
 * Cancels an order that has not left yet - including one booked with the
 * courier but not collected: its pieces go back on the shelf, a booked
 * shipment is called off, and a website order is cancelled in Shopify too,
 * without emailing the customer. Used from the Orders and packing screens.
 */
export function CancelOrderDialog({
  order,
  onClose,
  onDone,
}: {
  order: { id: string; order_number: string; shopify_order_id: number | null; tracking_number?: string | null };
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('cancel_order', {
      p_order_id: order.id,
      p_reason: reason.trim() || null,
    });
    if (rpcError) {
      setBusy(false);
      setError(arabicError(rpcError));
      return;
    }
    // Queued by the database; sent now rather than in a minute. A failure
    // here is retried by the Worker, so it does not stop the cancel.
    if (order.shopify_order_id) await sendOrderToShopify(order.id);
    setBusy(false);
    onDone();
  }

  return (
    <Modal open title={t('orders.cancelTitle', { orderNumber: order.order_number })} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">{t('orders.cancelHelp')}</p>
        {order.shopify_order_id ? <p className="text-sm text-stone-600">{t('orders.cancelShopify')}</p> : null}
        {/* Booked with Accurate: the CRM cannot call their courier off. */}
        {order.tracking_number ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {t('orders.cancelPickup', { tracking: order.tracking_number })}
          </p>
        ) : null}
        <Field label={t('orders.cancelReason')}>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex justify-end gap-2">
          {/* Not "cancel": beside "cancel the order" that reads as the same button. */}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('orders.keepOrder')}
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? t('app.loading') : t('orders.cancelConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
