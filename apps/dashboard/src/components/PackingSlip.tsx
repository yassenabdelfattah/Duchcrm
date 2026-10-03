import { useEffect, useState } from 'react';
import { formatDate, formatEGP } from '@duch/shared';
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
 * The paper that goes in the box (البوليصة).
 *
 * The owner's layout (2026-10-04): what is in the parcel and nothing else -
 * product, quantity, price per piece, line total, and the total. The
 * courier's own label carries the customer and the amount to collect, and the
 * invoice carries the rest. The order number stays at the top so the packer
 * can match the paper to the box.
 */
export function PackingSlip({ order, onClose }: { order: SlipOrder; onClose: () => void }) {
  const { t } = useLocale();
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

  const goodsTotal = (lines ?? []).reduce((sum, line) => sum + Number(line.total_egp), 0);

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-white p-4 print:p-0">
      <div className="no-print mb-4 flex gap-2">
        <Button onClick={() => window.print()}>{t('app.print')}</Button>
        <Button variant="secondary" onClick={onClose}>
          {t('app.close')}
        </Button>
      </div>

      <div dir="rtl" lang="ar" className="mx-auto max-w-[148mm] font-arabic text-[13px] leading-relaxed">
        <header className="flex items-end justify-between border-b-2 border-duch-ink pb-2">
          <img src="/logo-black.png" alt="DUCH" className="h-[18mm] w-auto" />
          <div className="text-end">
            <p className="tabular text-lg font-extrabold" dir="ltr">
              {order.order_number}
            </p>
            <p className="tabular text-xs text-stone-500">
              <bdi dir="ltr">{formatDate(order.created_at, 'ar')}</bdi>
            </p>
          </div>
        </header>

        {!lines ? (
          <Spinner />
        ) : (
          <table className="mt-1 w-full">
            <thead>
              <tr className="border-b border-stone-300 text-xs text-stone-600">
                <th className="py-2 text-start font-bold">المنتج</th>
                <th className="w-14 py-2 text-center font-bold">الكمية</th>
                <th className="w-24 py-2 text-end font-bold">سعر القطعة</th>
                <th className="w-24 py-2 text-end font-bold">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={`${line.sku}:${index}`} className="border-b border-stone-200 align-top">
                  <td className="py-2">
                    <span className="block font-semibold">
                      <bdi>{line.title}</bdi>
                    </span>
                    {/* The SKU and size are what the packer checks against
                        the shelf before sealing the box. */}
                    <span className="tabular block text-[11px] text-stone-500">
                      <bdi dir="ltr">{line.sku}</bdi>
                      {line.variant_title ? (
                        <>
                          {' · '}
                          <bdi>{line.variant_title}</bdi>
                        </>
                      ) : null}
                    </span>
                  </td>
                  <td className="tabular py-2 text-center text-base font-bold">{line.quantity}</td>
                  <td className="tabular py-2 text-end">
                    {formatEGP(Number(line.unit_price_egp), 'ar')}
                  </td>
                  <td className="tabular py-2 text-end">{formatEGP(Number(line.total_egp), 'ar')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-duch-ink">
                <td colSpan={3} className="pt-2 font-extrabold">
                  الإجمالي
                </td>
                <td className="tabular pt-2 text-end text-base font-extrabold">
                  {formatEGP(goodsTotal, 'ar')}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
