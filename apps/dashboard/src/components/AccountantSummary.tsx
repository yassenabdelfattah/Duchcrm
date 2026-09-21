import { useMemo, useRef, useState } from 'react';
import { formatDate, formatEGP } from '@duch/shared';
import { useLocale } from '../i18n';
import { Button, Card, EmptyState } from './ui';

export interface StatementLine {
  note: string | null;
  line_id: string;
  tracking_number: string | null;
  outcome: string;
  collected_egp: number;
  fee_egp: number;
  net_egp: number;
  order_number: string | null;
  customer_name: string | null;
  governorate: string | null;
  items: string | null;
}

export interface ProductRow {
  title: string;
  unit_price_egp: number;
  quantity: number;
  total_egp: number;
}

export interface Breakdown {
  goods_egp: number;
  collected_egp: number;
  fees_egp: number;
  net_egp: number;
  collection_difference_egp: number;
}

export interface StatementHeader {
  reference: string | null;
  received_at: string | null;
  net_received_egp: number | null;
}

/**
 * What the accountant gets.
 *
 * He keeps a paper ledger, and what he writes down is products and prices, not
 * order numbers - "this transfer was three hoodies at 1,450 and two cargos at
 * 1,850". So the products lead, and the arithmetic underneath shows how they
 * become the figure that reached the bank: goods, plus the shipping customers
 * paid, less what the courier charged.
 *
 * The refused parcels are listed after that, because they are what explains
 * the courier's charges being larger than the deliveries would suggest.
 *
 * Offered both ways because both get used: a copyable block for the message
 * that actually gets sent, and a printable sheet to go with the cash.
 */
export function AccountantSummary({
  header,
  lines,
  products,
  breakdown,
}: {
  header: StatementHeader;
  lines: StatementLine[];
  products: ProductRow[];
  breakdown: Breakdown | null;
}) {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<'idle' | 'copied' | 'selected'>('idle');
  const messageBox = useRef<HTMLTextAreaElement>(null);

  const deductions = lines.filter((l) => l.outcome !== 'delivered');

  const message = useMemo(() => {
    if (!breakdown) return '';
    const out: string[] = [];

    out.push(`${t('settlements.title')} — ${header.reference ?? ''}`.trim());
    if (header.received_at) out.push(formatDate(header.received_at, locale));
    out.push('');

    if (products.length) {
      out.push(`${t('settlements.products')}:`);
      for (const p of products) {
        out.push(
          `${p.title} — ${p.quantity} × ${formatEGP(Number(p.unit_price_egp), locale)} = ${formatEGP(Number(p.total_egp), locale)}`,
        );
      }
      out.push('');
    }

    // No shipping line. The customer paid it at the door and Accurate kept
    // it, so it never reaches the transfer he is reconciling - printing it
    // here only gives him a number he has to be told to ignore.
    out.push(`${t('settlements.goodsTotal')}: ${formatEGP(Number(breakdown.goods_egp), locale)}`);
    if (Number(breakdown.collection_difference_egp) !== 0) {
      out.push(
        `${t('settlements.collectionDifference')}: ${formatEGP(Number(breakdown.collection_difference_egp), locale)}`,
      );
    }
    if (Number(breakdown.fees_egp) !== 0) {
      out.push(
        `${t('settlements.courierCharges')}: −${formatEGP(Number(breakdown.fees_egp), locale)}`,
      );
    }

    if (deductions.length) {
      out.push('');
      out.push(`${t('settlements.debits')}:`);
      for (const line of deductions) {
        const who = [line.order_number, line.customer_name].filter(Boolean).join(' · ');
        out.push(
          `${who} · ${t(`settlementOutcome.${line.outcome}`)} — ${formatEGP(Number(line.fee_egp), locale)}`,
        );
      }
    }

    out.push('');
    out.push(`${t('settlements.netLine')}: ${formatEGP(Number(breakdown.net_egp), locale)}`);
    return out.join('\n');
  }, [breakdown, deductions, header, locale, products, t]);

  /**
   * Copying has to work from a phone on the shop wifi.
   *
   * navigator.clipboard only exists on a secure origin, and the dev server is
   * plain http on a LAN address - so on the very device this message gets sent
   * from, the modern API is simply absent. Without a fallback the button would
   * do nothing at all, silently.
   *
   * So: use the real API where it exists, fall back to selecting the textarea
   * and the old execCommand, and if even that fails leave the text selected
   * and say so, because a selected block the person copies by hand still gets
   * the job done.
   */
  async function copy() {
    const area = messageBox.current;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
        setStatus('copied');
        setTimeout(() => setStatus('idle'), 2000);
        return;
      }
    } catch {
      // Fall through to the selection route below.
    }

    if (area) {
      area.focus();
      area.select();
      area.setSelectionRange(0, message.length);
      try {
        if (document.execCommand('copy')) {
          setStatus('copied');
          setTimeout(() => setStatus('idle'), 2000);
          return;
        }
      } catch {
        // Nothing left to try; the text is selected either way.
      }
    }

    setStatus('selected');
  }

  if (!breakdown) return null;

  return (
    <Card className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold">{t('settlements.forAccountant')}</h2>
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" className="min-h-9 text-xs" onClick={copy}>
            {status === 'copied' ? t('settlements.copied') : t('settlements.copy')}
          </Button>
          <Button variant="secondary" className="min-h-9 text-xs" onClick={() => window.print()}>
            {t('settlements.print')}
          </Button>
        </div>
      </div>

      {/* The part he actually writes into the ledger. */}
      <section>
        <h3 className="mb-2 text-xs font-bold text-stone-500">{t('settlements.products')}</h3>
        {products.length === 0 ? (
          <EmptyState title={t('settlements.noProducts')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-sm">
              <thead className="text-xs uppercase text-stone-500">
                <tr>
                  <th className="py-2 text-start font-semibold">{t('settlements.product')}</th>
                  <th className="w-16 py-2 text-center font-semibold">{t('settlements.qty')}</th>
                  <th className="w-28 py-2 text-end font-semibold">{t('settlements.unitPrice')}</th>
                  <th className="w-28 py-2 text-end font-semibold">{t('settlements.lineTotal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-duch-line">
                {products.map((p, index) => (
                  <tr key={`${p.title}:${p.unit_price_egp}:${index}`}>
                    <td className="py-2 font-semibold">{p.title}</td>
                    <td className="tabular py-2 text-center text-base font-bold">{p.quantity}</td>
                    <td className="tabular py-2 text-end">
                      {formatEGP(Number(p.unit_price_egp), locale)}
                    </td>
                    <td className="tabular py-2 text-end font-semibold">
                      {formatEGP(Number(p.total_egp), locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* How those products become the figure that reached the bank. */}
      <dl className="space-y-1 border-t border-duch-line pt-3 text-sm">
        <Line label={t('settlements.goodsTotal')} value={formatEGP(Number(breakdown.goods_egp), locale)} />
        {Number(breakdown.collection_difference_egp) !== 0 ? (
          <Line
            label={t('settlements.collectionDifference')}
            value={formatEGP(Number(breakdown.collection_difference_egp), locale)}
            tone="warn"
          />
        ) : null}
        {Number(breakdown.fees_egp) !== 0 ? (
          <Line
            label={t('settlements.courierCharges')}
            value={`−${formatEGP(Number(breakdown.fees_egp), locale)}`}
            tone="bad"
          />
        ) : null}
        <div className="tabular flex justify-between border-t-2 border-duch-ink pt-2 text-base font-extrabold">
          <span>{t('settlements.netLine')}</span>
          <span>{formatEGP(Number(breakdown.net_egp), locale)}</span>
        </div>
      </dl>

      {/* Exactly what gets sent, and the fallback when the browser will not
          copy for us. Shown rather than hidden because seeing the message
          before sending it is worth something on its own. */}
      <section className="no-print border-t border-duch-line pt-3">
        <textarea
          ref={messageBox}
          readOnly
          dir="auto"
          value={message}
          onFocus={(event) => event.currentTarget.select()}
          rows={Math.min(14, message.split('\n').length + 1)}
          className="w-full resize-y rounded-lg border border-duch-line bg-stone-50 p-3 text-xs leading-relaxed"
        />
        {status === 'selected' ? (
          <p className="mt-1 text-xs text-amber-700">{t('settlements.copyManually')}</p>
        ) : null}
      </section>

      {deductions.length > 0 ? (
        <section className="border-t border-duch-line pt-3">
          <h3 className="mb-1 text-xs font-bold text-stone-500">{t('settlements.debits')}</h3>
          <ul className="divide-y divide-duch-line">
            {deductions.map((line) => (
              <li key={line.line_id} className="flex items-start gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="tabular block font-semibold">
                    {line.order_number ?? t('settlements.unmatched')}
                  </span>
                  <span className="block text-xs text-stone-500">
                    {[line.customer_name, t(`settlementOutcome.${line.outcome}`)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="tabular font-semibold text-red-700">
                  −{formatEGP(Number(line.fee_egp), locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'bad';
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-stone-600">{label}</dt>
      <dd
        className={
          tone === 'bad'
            ? 'tabular font-semibold text-red-700'
            : tone === 'warn'
              ? 'tabular font-semibold text-amber-700'
              : 'tabular font-semibold'
        }
      >
        {value}
      </dd>
    </div>
  );
}
