import { useEffect, useState } from 'react';
import { calculateInvoiceTotals, formatDate, formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { Button, ErrorNote, Spinner } from './ui';

/**
 * The A5 invoice.
 *
 * This is the formal document - the one a customer keeps, a wholesale buyer
 * files, and the accountant can put beside his ledger. The thermal receipt
 * stays for walk-in counter sales; anything that ships gets this.
 *
 * Two deliberate differences from the receipt and the packing slip:
 *
 * It is bilingual on the page rather than in the interface language. An
 * invoice outlives the session that printed it and may be read by someone who
 * was never looking at the app, so every label carries both Arabic and
 * English. The layout is fixed right-to-left with Arabic leading, so the same
 * order produces the same document whoever prints it.
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
  discount_egp: number;
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
  channel: string;
  created_at: string;
  subtotal_egp: number;
  discount_egp: number;
  shipping_egp: number;
  total_egp: number;
  payment_method: string | null;
  payment_status: string;
  note: string | null;
  customers: InvoiceCustomer | null;
}

/**
 * Seller details, edited in settings rather than in code. Everything except
 * the name is optional, and an empty field prints nothing at all rather than
 * a heading with a blank beside it.
 */
interface BusinessIdentity {
  legal_name_ar?: string | null;
  legal_name_en?: string | null;
  address_ar?: string | null;
  address_en?: string | null;
  tax_number?: string | null;
  commercial_register?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
}

/**
 * Payment methods in both languages.
 *
 * The dictionaries hold one language at a time, which is right for the
 * interface and wrong for this document - a customer reading the invoice in a
 * month has no locale setting. Both readings are printed, so the paper says
 * the same thing whoever produced it.
 */
const PAYMENT_LABELS: Record<string, { ar: string; en: string }> = {
  cash: { ar: 'نقدي', en: 'Cash' },
  card: { ar: 'بطاقة', en: 'Card' },
  instapay: { ar: 'إنستاباي', en: 'InstaPay' },
  cod: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' },
  bank_transfer: { ar: 'تحويل بنكي', en: 'Bank transfer' },
};

/** A label in both languages, Arabic leading. */
function Bi({ ar, en, className }: { ar: string; en: string; className?: string }) {
  return (
    <span className={className}>
      <span className="block">{ar}</span>
      <span className="block text-[8px] font-normal tracking-wide text-stone-500" dir="ltr">
        {en}
      </span>
    </span>
  );
}

export function Invoice({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { t } = useLocale();
  const [order, setOrder] = useState<InvoiceOrder | null>(null);
  const [lines, setLines] = useState<InvoiceLine[] | null>(null);
  const [business, setBusiness] = useState<BusinessIdentity>({});
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
      const [orderResult, lineResult, settingResult] = await Promise.all([
        supabase
          .from('orders')
          .select(
            'order_number, channel, created_at, subtotal_egp, discount_egp, shipping_egp,' +
              ' total_egp, payment_method, payment_status, note,' +
              ' customers ( full_name, phone, address_line1, address_line2, city, governorate )',
          )
          .eq('id', orderId)
          .single(),
        supabase
          .from('order_line_items')
          .select('sku, title, variant_title, quantity, unit_price_egp, discount_egp, total_egp')
          .eq('order_id', orderId)
          .order('created_at'),
        supabase.from('settings').select('value').eq('key', 'business_identity').maybeSingle(),
      ]);

      if (cancelled) return;

      if (orderResult.error) {
        setError(orderResult.error.message);
        return;
      }

      setOrder(orderResult.data as unknown as InvoiceOrder);
      setLines((lineResult.data ?? []) as InvoiceLine[]);
      // Missing seller details are survivable - the invoice still prints with
      // the wordmark. Failing to read them is not worth blocking the print on.
      setBusiness((settingResult.data?.value ?? {}) as BusinessIdentity);
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
  const paymentLabel = order.payment_method
    ? (PAYMENT_LABELS[order.payment_method] ?? null)
    : null;

  const invoiceDate = formatDate(order.created_at, 'ar');
  const isPaid = order.payment_status === 'paid';

  const sellerAddress = [business.address_ar, business.address_en].filter(Boolean);
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

      {/* Fixed RTL: the document reads the same whoever printed it. */}
      <div
        dir="rtl"
        lang="ar"
        className="mx-auto max-w-[128mm] font-arabic text-[11px] leading-snug text-duch-ink print:max-w-none"
      >
        <header className="flex items-start justify-between border-b-2 border-duch-ink pb-3">
          <div>
            <p className="text-2xl font-extrabold tracking-widest" dir="ltr">
              DUCH
            </p>
            <p className="font-semibold">{business.legal_name_ar ?? 'دوتش'}</p>
            <p className="text-[10px] text-stone-500" dir="ltr">
              {business.legal_name_en ?? 'Duch'}
            </p>
            {sellerAddress.map((line) => (
              <p key={line} className="text-[10px] text-stone-600">
                <bdi>{line}</bdi>
              </p>
            ))}
            {business.website ? (
              <p className="text-[10px] text-stone-500" dir="ltr">
                {business.website}
              </p>
            ) : null}
            {business.phone ? (
              <p className="tabular text-[10px] text-stone-500" dir="ltr">
                {business.phone}
              </p>
            ) : null}
          </div>

          <div className="text-end">
            <Bi ar="فاتورة" en="Invoice" className="text-lg font-extrabold" />
            <p className="tabular mt-1 text-base font-extrabold" dir="ltr">
              {order.order_number}
            </p>
            <p className="tabular text-[10px] text-stone-500">
              <bdi dir="ltr">{invoiceDate}</bdi>
            </p>
          </div>
        </header>

        {/* Registration numbers only appear once the business has them. */}
        {business.tax_number || business.commercial_register ? (
          <section className="flex gap-6 border-b border-stone-200 py-2 text-[10px]">
            {business.tax_number ? (
              <div className="flex gap-2">
                <Bi ar="الرقم الضريبي" en="Tax number" className="font-bold" />
                <span className="tabular" dir="ltr">
                  {business.tax_number}
                </span>
              </div>
            ) : null}
            {business.commercial_register ? (
              <div className="flex gap-2">
                <Bi ar="السجل التجاري" en="Commercial register" className="font-bold" />
                <span className="tabular" dir="ltr">
                  {business.commercial_register}
                </span>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* A walk-in pays and leaves without giving a name. Printing an empty
            customer block on those invoices is just a dash on the paper. */}
        {customer?.full_name || customer?.phone || customerAddress ? (
          <section className="border-b border-dashed border-stone-400 py-3">
            <Bi ar="العميل" en="Customer" className="text-[10px] font-bold text-stone-500" />
            {/* <bdi> isolates a run of text from the surrounding direction
                without changing where the line sits. Names and addresses are
                entered in either language, and "8 Abbas El Akkad, Nasr City"
                in a right-to-left block otherwise renders with the house
                number moved to the far end of the line. Using dir="auto" on
                the paragraph would fix the order but drag the text to the
                other margin, which breaks the column down the page. */}
            <p className="mt-1 font-semibold">
              <bdi>{customer?.full_name ?? '—'}</bdi>
            </p>
            {customer?.phone ? (
              <p className="tabular">
                <bdi dir="ltr">{customer.phone}</bdi>
              </p>
            ) : null}
            {customerAddress ? (
              <p className="text-stone-600">
                <bdi>{customerAddress}</bdi>
              </p>
            ) : null}
          </section>
        ) : null}

        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-300 text-[10px]">
              <th className="py-2 text-start font-bold">
                <Bi ar="الصنف" en="Item" />
              </th>
              <th className="w-10 py-2 text-center font-bold">
                <Bi ar="الكمية" en="Qty" />
              </th>
              <th className="w-20 py-2 text-end font-bold">
                <Bi ar="سعر الوحدة" en="Unit price" />
              </th>
              <th className="w-20 py-2 text-end font-bold">
                <Bi ar="الإجمالي" en="Amount" />
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={`${line.sku}:${index}`} className="border-b border-stone-200 align-top">
                <td className="py-2">
                  {/* Product titles are stored as entered, in one language. */}
                  <span className="block font-semibold">
                    <bdi>{line.title}</bdi>
                  </span>
                  <span className="tabular block text-[9px] text-stone-500" dir="ltr">
                    {line.sku}
                    {line.variant_title ? ` · ${line.variant_title}` : ''}
                  </span>
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
            <div className="tabular flex items-start justify-between py-1">
              <Bi ar="المجموع" en="Subtotal" className="text-[10px] font-bold" />
              <span>{formatEGP(totals.subtotal_egp, 'ar')}</span>
            </div>

            {totals.discount_egp > 0 ? (
              <div className="tabular flex items-start justify-between py-1">
                <Bi ar="الخصم" en="Discount" className="text-[10px] font-bold" />
                <span>−{formatEGP(totals.discount_egp, 'ar')}</span>
              </div>
            ) : null}

            {totals.shipping_egp > 0 ? (
              <div className="tabular flex items-start justify-between py-1">
                <Bi ar="الشحن" en="Shipping" className="text-[10px] font-bold" />
                <span>{formatEGP(totals.shipping_egp, 'ar')}</span>
              </div>
            ) : null}

            {/* The figure that matters: goods plus shipping. */}
            <div className="tabular mt-2 flex items-center justify-between border-t-2 border-duch-ink pt-2">
              <Bi ar="المستحق" en="Total due" className="text-xs font-extrabold" />
              <span className="text-lg font-extrabold">{formatEGP(totals.payable_egp, 'ar')}</span>
            </div>
          </div>
        </section>

        <section className="mt-3 flex items-center justify-between border-t border-dashed border-stone-400 pt-3">
          <div>
            <Bi
              ar="طريقة الدفع"
              en="Payment method"
              className="text-[10px] font-bold text-stone-500"
            />
            {paymentLabel ? (
              <p className="font-semibold">
                {paymentLabel.ar} · {paymentLabel.en}
              </p>
            ) : (
              <p className="font-semibold">—</p>
            )}
          </div>

          {isPaid ? (
            <div className="rounded-lg border-2 border-duch-ink px-4 py-2 text-center">
              <Bi ar="مدفوعة" en="Paid" className="text-sm font-extrabold" />
            </div>
          ) : (
            <div className="rounded-lg border-2 border-dashed border-stone-500 px-4 py-2 text-center text-stone-700">
              <Bi ar="غير مدفوعة" en="Unpaid" className="text-sm font-extrabold" />
            </div>
          )}
        </section>

        {order.note ? (
          <p className="pt-3 text-stone-700">
            <bdi>{order.note}</bdi>
          </p>
        ) : null}

        <p className="pt-6 text-center text-[10px] text-stone-500">
          شكراً لتسوقك من دوتش · Thank you for shopping with Duch
        </p>
      </div>
    </div>
  );
}
