import { formatDateTime, formatEGP } from '@duch/shared';
import { useLocale } from '../i18n';
import type { CompletedSale } from '../pages/StoreSale';

/**
 * The printable receipt.
 *
 * Sized for an 80mm thermal roll, which is what the counter printer takes.
 * It inherits the page direction, so an Arabic receipt prints right to left
 * with Arabic text and Latin digits - prices have to be comparable against the
 * card terminal slip at a glance.
 *
 * Phase 3 replaces this with a proper A5 PDF invoice; this is the version a
 * customer walks out with today.
 */
export function Receipt({ sale }: { sale: CompletedSale }) {
  const { t, locale } = useLocale();

  const date = formatDateTime(sale.created_at, locale);

  return (
    <div className="mx-auto w-full max-w-[80mm] bg-white p-4 text-[13px] leading-relaxed print:max-w-none print:p-0">
      <header className="border-b border-dashed border-stone-400 pb-2 text-center">
        <p className="text-lg font-extrabold tracking-widest">DUCH</p>
        <p className="text-xs text-stone-500">duch.store</p>
      </header>

      <div className="tabular flex justify-between py-2 text-xs">
        <span>{sale.order_number}</span>
        <span>{date}</span>
      </div>

      <table className="w-full border-y border-dashed border-stone-400 py-1">
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.variant_id} className="align-top">
              <td className="py-1">
                <span className="block font-semibold">{line.title}</span>
                <span className="tabular block text-[11px] text-stone-500">
                  {line.sku}
                  {line.variant_label ? ` · ${line.variant_label}` : ''}
                </span>
              </td>
              <td className="tabular w-8 py-1 text-center">{line.quantity}</td>
              <td className="tabular w-20 py-1 text-end">
                {formatEGP(line.unit_price_egp * line.quantity, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="tabular flex justify-between py-2 text-base font-extrabold">
        <span>{t('sale.total')}</span>
        <span>{formatEGP(sale.total_egp, locale)}</span>
      </div>

      <div className="flex justify-between border-t border-dashed border-stone-400 pt-2 text-xs">
        <span>{t('sale.paymentMethod')}</span>
        <span className="font-semibold">{t(`payment.${sale.payment_method}`)}</span>
      </div>

      <p className="pt-4 text-center text-xs text-stone-500">
        {locale === 'ar' ? 'شكراً لتسوقك من دوتش' : 'Thank you for shopping with Duch'}
      </p>
    </div>
  );
}
