import { useMemo, useState } from 'react';
import { formatDate, formatEGP } from '@duch/shared';
import { useLocale } from '../i18n';
import { Button, Card } from './ui';

export interface StatementLine {
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

export interface StatementHeader {
  reference: string | null;
  received_at: string | null;
  net_received_egp: number | null;
}

/**
 * What the accountant gets.
 *
 * Today this is typed out by hand as a WhatsApp message: every order the money
 * came from, then the returns and fees as minuses, then the total. He keeps a
 * paper ledger, so the shape matters more than the format - money in on one
 * side, deductions on the other, one net figure at the bottom.
 *
 * Offered both ways because both get used: a copyable block for the message he
 * actually sends, and a printable sheet to go with the cash.
 */
export function AccountantSummary({
  header,
  lines,
}: {
  header: StatementHeader;
  lines: StatementLine[];
}) {
  const { t, locale } = useLocale();
  const [copied, setCopied] = useState(false);

  const credits = lines.filter((l) => l.net_egp > 0);
  const debits = lines.filter((l) => l.net_egp <= 0);
  const net = lines.reduce((sum, l) => sum + Number(l.net_egp), 0);

  const message = useMemo(() => {
    const out: string[] = [];
    out.push(`${t('settlements.title')} — ${header.reference ?? ''}`.trim());
    if (header.received_at) out.push(formatDate(header.received_at, locale));
    out.push('');

    if (credits.length) {
      out.push(`${t('settlements.credits')}:`);
      for (const line of credits) {
        const who = [line.order_number, line.customer_name].filter(Boolean).join(' · ');
        const what = line.items ? ` · ${line.items}` : '';
        out.push(`${who}${what} — ${formatEGP(Number(line.net_egp), locale)}`);
      }
      out.push('');
    }

    if (debits.length) {
      out.push(`${t('settlements.debits')}:`);
      for (const line of debits) {
        const who = [line.order_number, line.customer_name].filter(Boolean).join(' · ');
        const why = t(`settlementOutcome.${line.outcome}`);
        out.push(`${who} · ${why} — ${formatEGP(Math.abs(Number(line.net_egp)), locale)}-`);
      }
      out.push('');
    }

    out.push(`${t('settlements.netLine')}: ${formatEGP(net, locale)}`);
    return out.join('\n');
  }, [credits, debits, header, locale, net, t]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the text is on screen and selectable,
      // so there is still a way to get it out.
      setCopied(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="no-print flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold">{t('settlements.forAccountant')}</h2>
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" className="min-h-9 text-xs" onClick={copy}>
            {copied ? t('settlements.copied') : t('settlements.copy')}
          </Button>
          <Button variant="secondary" className="min-h-9 text-xs" onClick={() => window.print()}>
            {t('settlements.print')}
          </Button>
        </div>
      </div>

      <div className="space-y-4 text-sm">
        {credits.length > 0 ? (
          <section>
            <h3 className="mb-1 text-xs font-bold text-stone-500">{t('settlements.credits')}</h3>
            <ul className="divide-y divide-duch-line">
              {credits.map((line) => (
                <li key={line.line_id} className="flex items-start gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="tabular block font-semibold">
                      {line.order_number ?? t('settlements.unmatched')}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {[line.customer_name, line.items].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="tabular font-semibold">
                    {formatEGP(Number(line.net_egp), locale)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {debits.length > 0 ? (
          <section>
            <h3 className="mb-1 text-xs font-bold text-stone-500">{t('settlements.debits')}</h3>
            <ul className="divide-y divide-duch-line">
              {debits.map((line) => (
                <li key={line.line_id} className="flex items-start gap-3 py-2">
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
                    −{formatEGP(Math.abs(Number(line.net_egp)), locale)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="tabular flex justify-between border-t-2 border-duch-ink pt-2 text-base font-extrabold">
          <span>{t('settlements.netLine')}</span>
          <span>{formatEGP(net, locale)}</span>
        </div>
      </div>
    </Card>
  );
}
