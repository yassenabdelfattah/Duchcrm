import { useEffect, useState } from 'react';
import { formatDateTime, formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { Button, Spinner } from './ui';

interface SlipLine {
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_price_egp: number;
  total_egp: number;
}

export interface SlipOrder {
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  address_line1: string | null;
  city: string | null;
  governorate: string | null;
  total_egp: number;
  shipping_egp: number;
  cod_amount_egp: number | null;
  payment_method: string | null;
  tracking_number: string | null;
  created_at: string;
  note: string | null;
}

/**
 * The paper that goes in the box.
 *
 * Two jobs: the packer checks the items against it before sealing, and the
 * customer finds it inside. The amount to collect is printed large because a
 * cash-on-delivery parcel handed over with the wrong figure is an argument at
 * someone's front door.
 */
export function PackingSlip({ order, onClose }: { order: SlipOrder; onClose: () => void }) {
  const { t, locale } = useLocale();
  const [lines, setLines] = useState<SlipLine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('order_line_items')
      .select('sku, title, variant_title, quantity, unit_price_egp, total_egp')
      .eq('order_id', order.order_id)
      .order('created_at')
      .then(({ data }) => {
        if (!cancelled) setLines((data ?? []) as SlipLine[]);
      });
    return () => {
      cancelled = true;
    };
  }, [order.order_id]);

  const address = [order.address_line1, order.city, order.governorate]
    .filter(Boolean)
    .join('، ');

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-white p-4 print:p-0">
      <div className="no-print mb-4 flex gap-2">
        <Button onClick={() => window.print()}>{t('app.print')}</Button>
        <Button variant="secondary" onClick={onClose}>
          {t('app.close')}
        </Button>
      </div>

      <div className="mx-auto max-w-[148mm] text-[13px] leading-relaxed">
        <header className="flex items-start justify-between border-b-2 border-duch-ink pb-2">
          <div>
            <p className="text-xl font-extrabold tracking-widest">DUCH</p>
            <p className="text-xs text-stone-500">duch.store</p>
          </div>
          <div className="tabular text-end">
            <p className="text-lg font-extrabold">{order.order_number}</p>
            <p className="text-xs text-stone-500">{formatDateTime(order.created_at, locale)}</p>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-4 border-b border-dashed border-stone-400 py-3">
          <div>
            <p className="text-xs font-bold text-stone-500">{t('sale.customer')}</p>
            <p className="font-semibold">{order.customer_name ?? '—'}</p>
            <p className="tabular" dir="ltr">
              {order.customer_phone ?? t('queue.noPhone')}
            </p>
            {address ? <p className="mt-1 text-stone-600">{address}</p> : null}
          </div>
          <div className="text-end">
            <p className="text-xs font-bold text-stone-500">{t('queue.trackingNumber')}</p>
            <p className="tabular font-semibold" dir="ltr">
              {order.tracking_number ?? '—'}
            </p>
          </div>
        </section>

        {!lines ? (
          <Spinner />
        ) : (
          <table className="w-full border-b border-dashed border-stone-400 py-2">
            <thead>
              <tr className="text-xs text-stone-500">
                <th className="py-2 text-start font-bold">{t('stock.product')}</th>
                <th className="w-12 py-2 text-center font-bold">{t('sale.quantity')}</th>
                <th className="w-24 py-2 text-end font-bold">{t('sale.lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={`${line.sku}:${index}`} className="border-t border-stone-200 align-top">
                  <td className="py-2">
                    <span className="block font-semibold">{line.title}</span>
                    <span className="tabular block text-[11px] text-stone-500">
                      {line.sku}
                      {line.variant_title ? ` · ${line.variant_title}` : ''}
                    </span>
                  </td>
                  <td className="tabular py-2 text-center text-base font-bold">{line.quantity}</td>
                  <td className="tabular py-2 text-end">
                    {formatEGP(Number(line.total_egp), locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <section className="py-3">
          <div className="tabular flex justify-between">
            <span>{t('sale.subtotal')}</span>
            <span>{formatEGP(Number(order.total_egp), locale)}</span>
          </div>
          {Number(order.shipping_egp) > 0 ? (
            <div className="tabular flex justify-between">
              <span>{t('queue.collect')}</span>
              <span>{formatEGP(Number(order.shipping_egp), locale)}</span>
            </div>
          ) : null}

          {/* The figure the courier must actually collect at the door. */}
          {order.payment_method === 'cod' ? (
            <div className="tabular mt-3 flex items-center justify-between rounded-lg border-2 border-duch-ink px-3 py-2">
              <span className="font-bold">{t('queue.collect')}</span>
              <span className="text-xl font-extrabold">
                {formatEGP(
                  Number(order.cod_amount_egp ?? Number(order.total_egp) + Number(order.shipping_egp)),
                  locale,
                )}
              </span>
            </div>
          ) : (
            <div className="mt-3 rounded-lg bg-stone-100 px-3 py-2 text-center font-bold">
              {t('paymentStatus.paid')}
            </div>
          )}
        </section>

        {order.note ? (
          <p className="border-t border-dashed border-stone-400 pt-2 text-stone-700">
            {order.note}
          </p>
        ) : null}

        <p className="pt-6 text-center text-xs text-stone-500">
          {locale === 'ar' ? 'شكراً لتسوقك من دوتش' : 'Thank you for shopping with Duch'}
        </p>
      </div>
    </div>
  );
}
