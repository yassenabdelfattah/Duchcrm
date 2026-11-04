import { useMemo } from 'react';
import { Link } from 'react-router';
import { Copy, Printer } from 'lucide-react';
import { cairoDate, formatDate, formatEGP } from '@duch/shared';
import { WAITING, completedSales, daysBetween, type CompletedItem, type Range, type StandingOrder } from '../../lib/reportMath';
import { useLocale } from '../../i18n';
import { BarList } from '../../components/charts';
import { Button, Card, toast } from '../../components/ui';
import { DataTable, Panel, StatTile, wholeEGP, type Column } from './parts';
import { Line, type T } from './columns';
import type { ReportData } from './useReportData';

/**
 * The month as the owner reads it (2026-11-04): the orders placed in the
 * range that are complete - delivered, and their money ours - what they came
 * to, and what of the range is not complete yet. Then what they sold: the ten
 * variants that sold the most pieces, and every item, the way a statement
 * lists them ("5 × Black Puffer Jacket"). See completedSales.
 */
export function CompletedReport({ data, range }: { data: ReportData; range: Range }) {
  const { t, locale } = useLocale();
  const done = useMemo(() => completedSales(data.lines, data.returns, data.orders, range), [data, range]);
  const money = (value: number) => formatEGP(value, locale);
  const period = t('analytics.completed.scope', { from: formatDate(range.from, locale), to: formatDate(range.to, locale) });
  const waiting = WAITING.reduce((total, standing) => total + done.byStanding[standing].orders, 0);
  const waitingNet = WAITING.reduce((total, standing) => total + done.byStanding[standing].net, 0);

  const itemName = (row: CompletedItem) => [row.label, row.detail].filter(Boolean).join(' ');

  async function copyItems() {
    const text = [
      `${t('analytics.completed.itemsTitle')} - ${period}`,
      ...done.items.map((row) => `${row.pieces} × ${itemName(row)}`),
      t('analytics.completed.itemsTotal', { count: done.pieces, amount: money(done.net) }),
    ].join('\n');
    toast(t((await copyText(text)) ? 'analytics.completed.copied' : 'analytics.completed.copyFailed'));
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-1">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-semibold">{period}</p>
            <p className="text-xs text-stone-500">{t('analytics.completed.rule')}</p>
          </div>
          <Button variant="secondary" className="no-print min-h-9 text-xs" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden />
            {t('analytics.custom.print')}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('analytics.completed.net')} value={wholeEGP(done.net, locale)} hint={t('analytics.completed.netHint')} />
        <StatTile label={t('analytics.completed.orders')} value={String(done.orders)} hint={t('analytics.completed.ofPlaced', { count: done.placed })} />
        <StatTile label={t('analytics.completed.pieces')} value={String(done.pieces)} />
        <StatTile label={t('analytics.completed.average')} value={wholeEGP(done.averageOrder, locale)} />
      </div>

      <Card>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Line label={t('analytics.completed.net')} value={money(done.net)} strong />
          <Line label={t('analytics.completed.shipping')} value={money(done.shipping)} />
        </dl>
      </Card>

      <Panel title={t('analytics.completed.waitingTitle')} help={t('analytics.completed.waitingHelp')}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {WAITING.map((standing) => (
            <Line
              key={standing}
              label={t(`analytics.completed.standing.${standing}`)}
              value={`${t('analytics.ordersNow', { count: done.byStanding[standing].orders })} · ${money(done.byStanding[standing].net)}`}
            />
          ))}
        </dl>
        <dl className="border-t border-duch-line pt-2 text-sm">
          <Line
            label={t('analytics.completed.waitingTotal')}
            value={`${t('analytics.ordersNow', { count: waiting })} · ${money(waitingNet)}`}
            strong
          />
        </dl>
        <p className="text-xs text-stone-500">
          {t('analytics.completed.addsUp', {
            placed: done.placed,
            completed: done.orders,
            waiting,
            back: done.byStanding.cameBack.orders,
          })}
        </p>
        <DataTable
          columns={waitingColumns(t, locale)}
          rows={done.waiting}
          rowKey={(row) => row.order_id}
          fileName={`not-complete-${range.from}-${range.to}`}
          empty={t('analytics.completed.noneWaiting')}
          limit={10}
        />
      </Panel>

      <Panel title={t('analytics.completed.topTitle')} help={t('analytics.completed.topHelp')}>
        <BarList
          rows={done.variants.slice(0, 10).map((row) => ({
            key: row.key,
            label: (
              <span className="flex flex-wrap items-baseline gap-x-2">
                <bdi>{row.label}</bdi>
                {row.detail ? <bdi className="text-xs text-stone-500">{row.detail}</bdi> : null}
              </span>
            ),
            value: row.pieces,
            note: wholeEGP(row.net, locale),
          }))}
          format={(value) => t('analytics.pieces', { count: value })}
          empty={t('analytics.completed.noneDone')}
        />
      </Panel>

      <Panel
        title={t('analytics.completed.itemsTitle')}
        help={t('analytics.completed.itemsHelp')}
        action={
          done.items.length > 0 ? (
            <Button variant="secondary" className="no-print min-h-9 text-xs" onClick={() => void copyItems()}>
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {t('analytics.completed.copy')}
            </Button>
          ) : null
        }
      >
        <DataTable
          columns={itemColumns(t, locale)}
          rows={done.items}
          rowKey={(row) => row.key}
          fileName={`items-sold-${range.from}-${range.to}`}
          empty={t('analytics.completed.noneDone')}
          totals={{ pieces: done.pieces, net: money(done.net) }}
        />
      </Panel>
    </div>
  );
}

/** An order not complete yet: where it is, and for how long since it was placed. */
function waitingColumns(t: T, locale: 'ar' | 'en'): Column<StandingOrder>[] {
  const today = cairoDate();
  const holder = (row: StandingOrder) => (row.courier ? t(`orders.courier.${row.courier}`) : '—');
  return [
    {
      key: 'order',
      label: t('analytics.col.order'),
      value: (row) => row.order_number,
      render: (row) => (
        <span className="block">
          <Link
            to={`/orders?q=${encodeURIComponent(row.order_number)}`}
            className="tabular font-semibold underline decoration-stone-300 underline-offset-2"
            dir="ltr"
          >
            {row.order_number}
          </Link>
          {row.replaces ? (
            <span className="block text-xs text-stone-500">
              {t('analytics.completed.replaces')}{' '}
              <span className="tabular" dir="ltr">
                {row.replaces}
              </span>
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'customer', label: t('analytics.col.customer'), value: (row) => row.customer_name, render: (row) => <bdi>{row.customer_name ?? '—'}</bdi> },
    { key: 'standing', label: t('analytics.completed.standingCol'), value: (row) => t(`analytics.completed.standing.${row.standing}`) },
    { key: 'status', label: t('analytics.col.status'), value: (row) => t(`fulfillment.${row.fulfillment_status}`) },
    { key: 'with', label: t('analytics.custom.money.with'), value: (row) => holder(row), render: (row) => <bdi>{holder(row)}</bdi> },
    { key: 'days', label: t('analytics.col.days'), value: (row) => daysBetween(row.placed_on, today) - 1, numeric: true },
    { key: 'pieces', label: t('analytics.col.pieces'), value: (row) => row.pieces, numeric: true },
    { key: 'net', label: t('analytics.col.goods'), value: (row) => row.net, render: (row) => formatEGP(row.net, locale), numeric: true },
  ];
}

/** Every item the completed orders sold, the product in its colour: pieces and what they came to. */
function itemColumns(t: T, locale: 'ar' | 'en'): Column<CompletedItem>[] {
  return [
    {
      key: 'item',
      label: t('analytics.col.product'),
      value: (row) => [row.label, row.detail].filter(Boolean).join(' '),
      render: (row) => (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <bdi className="font-semibold">{row.label}</bdi>
          {row.detail ? <bdi className="text-xs text-stone-500">{row.detail}</bdi> : null}
        </span>
      ),
    },
    { key: 'pieces', label: t('analytics.col.pieces'), value: (row) => row.pieces, numeric: true },
    { key: 'net', label: t('analytics.col.net'), value: (row) => row.net, render: (row) => formatEGP(row.net, locale), numeric: true },
  ];
}

/**
 * The list onto the clipboard, from a phone on the shop wifi too: the
 * clipboard API exists only on a secure origin, so a hidden text box and the
 * old copy command where it does not.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the text box.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
