import { useEffect, useState } from 'react';
import { calculateInvoiceTotals, formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { useLocale } from '../i18n';
import { Button, ErrorNote, Spinner } from './ui';

/**
 * The A5 invoice - the one the customer keeps.
 *
 * The owner's layout (2026-10-04), and nothing beyond it: who it is for (name,
 * phone, address), what they took (product, quantity, price per piece, line
 * total), shipping when there is any, and what they pay. Arabic only. The
 * order note is deliberately left off - it is written for staff, not for the
 * customer.
 *
 * It prints the amount the customer actually pays. `orders.total_egp` is the
 * goods total and excludes shipping - see calculateInvoiceTotals().
 */

interface InvoiceLine {
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_price_egp: number;
  total_egp: number;
}

interface InvoiceCustomer {
  full_name: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  governorate: string | null;
}

interface InvoiceOrder {
  order_number: string;
  created_at: string;
  subtotal_egp: number;
  discount_egp: number;
  shipping_egp: number;
  total_egp: number;
  customers: InvoiceCustomer | null;
}

export function Invoice({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { t } = useLocale();
  const [order, setOrder] = useState<InvoiceOrder | null>(null);
  const [lines, setLines] = useState<InvoiceLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The page size belongs to this document, not to the application. A global
  // @page rule in styles.css would also resize the 80mm thermal receipt and
  // the packing slip, so the rule is added while an invoice is open and taken
  // away again when it closes.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = '@page { size: A5; margin: 10mm; }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [orderResult, lineResult] = await Promise.all([
        supabase
          .from('orders')
          .select(
            'order_number, created_at, subtotal_egp, discount_egp, shipping_egp, total_egp,' +
              ' customers ( full_name, phone, address_line1, address_line2, city, governorate )',
          )
          .eq('id', orderId)
          .single(),
        supabase
          .from('order_line_items')
          .select('sku, title, variant_title, quantity, unit_price_egp, total_egp')
          .eq('order_id', orderId)
          .order('created_at'),
      ]);

      if (cancelled) return;

      if (orderResult.error) {
        setError(arabicError(orderResult.error));
        return;
      }

      setOrder(orderResult.data as unknown as InvoiceOrder);
      setLines((lineResult.data ?? []) as InvoiceLine[]);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (error) {
    return (
      <div className="fixed inset-0 z-50 overflow-auto bg-white p-4">
        <div className="no-print mb-4">
          <Button variant="secondary" onClick={onClose}>
            {t('app.close')}
          </Button>
        </div>
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (!order || !lines) {
    return (
      <div className="fixed inset-0 z-50 bg-white p-4">
        <Spinner label={t('app.loading')} />
      </div>
    );
  }

  const totals = calculateInvoiceTotals(order);
  const customer = order.customers;
  const customerAddress = [
    customer?.address_line1,
    customer?.address_line2,
    customer?.city,
    customer?.governorate,
  ]
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

      <div
        dir="rtl"
        lang="ar"
        className="mx-auto max-w-[128mm] font-arabic text-[12px] leading-snug text-duch-ink print:max-w-none"
      >
        <header className="flex items-end justify-between border-b-2 border-duch-ink pb-3">
          <div className="text-center">
            <img src="/logo-black.png" alt="DUCH" className="h-[22mm] w-auto" />
            <p className="text-[10px] text-stone-500" dir="ltr">
              duch.store
            </p>
          </div>

          <div className="text-end">
            <p className="text-lg font-extrabold">فاتورة</p>
            <p className="tabular text-base font-extrabold" dir="ltr">
              {order.order_number}
            </p>
            <p className="tabular text-[10px] text-stone-500">
              <bdi dir="ltr">{formatDate(order.created_at, 'ar')}</bdi>
            </p>
          </div>
        </header>

        {/* A walk-in who gave no details gets no empty customer block. */}
        {customer?.full_name || customer?.phone || customerAddress ? (
          <section className="grid gap-0.5 border-b border-dashed border-stone-400 py-3">
            <p className="text-[10px] font-bold text-stone-500">العميل</p>
            {/* <bdi> keeps a name or address typed in English in the right
                order inside the right-to-left page. */}
            <p className="text-sm font-bold">
              <bdi>{customer?.full_name ?? '—'}</bdi>
            </p>
            {customer?.phone ? (
              <p className="tabular">
                <bdi dir="ltr">{customer.phone}</bdi>
              </p>
            ) : null}
            {customerAddress ? (
              <p className="text-stone-700">
                <bdi>{customerAddress}</bdi>
              </p>
            ) : null}
          </section>
        ) : null}

        <table className="mt-1 w-full">
          <thead>
            <tr className="border-b border-stone-300 text-[10px] text-stone-600">
              <th className="py-2 text-start font-bold">المنتج</th>
              <th className="w-12 py-2 text-center font-bold">الكمية</th>
              <th className="w-20 py-2 text-end font-bold">سعر القطعة</th>
              <th className="w-20 py-2 text-end font-bold">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.sku}:${index}`} className="border-b border-stone-200 align-top">
                <td className="py-2">
                  <span className="block font-semibold">
                    <bdi>{line.title}</bdi>
                  </span>
                  {line.variant_title ? (
                    <span className="block text-[10px] text-stone-500">
                      <bdi>{line.variant_title}</bdi>
                    </span>
                  ) : null}
                </td>
                <td className="tabular py-2 text-center font-semibold">{line.quantity}</td>
                <td className="tabular py-2 text-end">
                  {formatEGP(Number(line.unit_price_egp), 'ar')}
                </td>
                <td className="tabular py-2 text-end">{formatEGP(Number(line.total_egp), 'ar')}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-3 flex justify-end">
          <div className="w-[70mm]">
            {/* Only shown when there is more than one figure to add up. */}
            {totals.discount_egp > 0 || totals.shipping_egp > 0 ? (
              <div className="tabular flex justify-between py-1">
                <span className="font-bold">المجموع</span>
                <span>{formatEGP(totals.subtotal_egp, 'ar')}</span>
              </div>
            ) : null}

            {totals.discount_egp > 0 ? (
              <div className="tabular flex justify-between py-1">
                <span className="font-bold">الخصم</span>
                <span>−{formatEGP(totals.discount_egp, 'ar')}</span>
              </div>
            ) : null}

            {totals.shipping_egp > 0 ? (
              <div className="tabular flex justify-between py-1">
                <span className="font-bold">الشحن</span>
                <span>{formatEGP(totals.shipping_egp, 'ar')}</span>
              </div>
            ) : null}

            {/* The figure that matters: goods plus shipping. */}
            <div className="tabular mt-2 flex items-center justify-between border-t-2 border-duch-ink pt-2">
              <span className="text-sm font-extrabold">الإجمالي</span>
              <span className="text-lg font-extrabold">{formatEGP(totals.payable_egp, 'ar')}</span>
            </div>
          </div>
        </section>

        <p className="pt-8 text-center text-[10px] text-stone-500">شكراً لتسوقك من دش</p>
      </div>
    </div>
  );
}
