import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAYMENT_METHODS,
  can,
  calculateInvoiceTotals,
  formatDateTime,
  formatEGP,
  type PaymentMethod,
} from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { useSearchParams } from 'react-router';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
import {
  Badge,
  Button,
  Card,
  Code,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  StatusPill,
  cx,
  type StatusTone,
} from '../components/ui';
import { Invoice } from '../components/Invoice';
import { OrderEditor } from '../components/OrderEditor';

/**
 * Every order, findable, and each one telling its whole story.
 *
 * The owner's ask (2026-10-04): an order in the list shows all of itself -
 * number, customer name, phone and address, the shipment number, what they
 * took, shipping and the note - and where it is now and for how long. The
 * list is searchable by any number or name someone quotes, filterable, and
 * split into the lists people check every day, each with its count.
 *
 * It reads v_order_list, which flattens all of that into one row per order.
 */

interface OrderItem {
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_price_egp: number;
  total_egp: number;
}

interface OrderRow {
  id: string;
  order_number: string;
  channel: string;
  created_at: string;
  fulfillment_status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal_egp: number;
  discount_egp: number;
  shipping_egp: number;
  total_egp: number;
  cancelled_at: string | null;
  note: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  shipment_id: string | null;
  tracking_number: string | null;
  courier: string | null;
  driver_name: string | null;
  shipment_status: string | null;
  handed_over_at: string | null;
  delivered_at: string | null;
  items: OrderItem[];
  unit_count: number;
  stage: 'to_ship' | 'on_the_road' | 'delivered' | 'back' | 'cancelled';
  stage_since: string;
}

const PAGE_SIZE = 50;

/** A parcel with the courier this long is late - the same line the custody report draws. */
const COURIER_LATE_DAYS = 7;

// --- Tabs and filters -----------------------------------------------------------

type TabKey = 'all' | 'to_ship' | 'on_the_road' | 'owed' | 'back';
const TABS: TabKey[] = ['all', 'to_ship', 'on_the_road', 'owed', 'back'];

interface Filters {
  channel: string;
  method: string;
  paid: '' | 'paid' | 'unpaid';
  delivery: '' | 'accurate' | 'own';
  period: '' | 'today' | '7' | '30';
}

const NO_FILTERS: Filters = { channel: '', method: '', paid: '', delivery: '', period: '' };
const STORAGE_KEY = 'duch.orders.view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST builder's generics are not worth spelling out here
type Query = any;

/** Narrows a query to one tab. "Owed" is delivered and not paid: the customer has it, we do not have the money. */
function applyTab(query: Query, tab: TabKey): Query {
  switch (tab) {
    case 'to_ship':
    case 'on_the_road':
      return query.eq('stage', tab);
    case 'owed':
      return query.eq('stage', 'delivered').eq('payment_status', 'pending');
    case 'back':
      return query.eq('stage', 'back');
    default:
      return query;
  }
}

function applyFilters(query: Query, filters: Filters): Query {
  let q = query;
  if (filters.channel) q = q.eq('channel', filters.channel);
  if (filters.method) q = q.eq('payment_method', filters.method);
  if (filters.paid === 'paid') q = q.eq('payment_status', 'paid');
  if (filters.paid === 'unpaid') q = q.eq('payment_status', 'pending');
  if (filters.delivery === 'own') q = q.eq('courier', 'own');
  if (filters.delivery === 'accurate') q = q.eq('courier', 'accurate');
  if (filters.period) {
    const since = new Date();
    if (filters.period === 'today') since.setHours(0, 0, 0, 0);
    else since.setDate(since.getDate() - Number(filters.period));
    q = q.gte('created_at', since.toISOString());
  }
  return q;
}

function readSavedView(): { tab: TabKey; filters: Filters } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      tab?: TabKey;
      filters?: Partial<Filters>;
    } | null;
    if (saved && TABS.includes(saved.tab as TabKey)) {
      return { tab: saved.tab as TabKey, filters: { ...NO_FILTERS, ...saved.filters } };
    }
  } catch {
    // Private browsing or a corrupt value: start from the defaults.
  }
  return { tab: 'all', filters: NO_FILTERS };
}

/**
 * Nothing more is owed on an order that was cancelled or whose goods came
 * back. The database refuses to mark either paid; the payment status of a
 * returned courier parcel stays unpaid only so its statement line is still
 * expected.
 */
function isClosed(row: { cancelled_at: string | null; fulfillment_status: string }): boolean {
  return (
    row.cancelled_at !== null ||
    row.fulfillment_status === 'returned' ||
    row.fulfillment_status === 'return_in_transit'
  );
}

export function Orders() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const maySettle = can(identity?.permissions, 'orders.settle');
  const mayEdit = can(identity?.permissions, 'orders.edit');

  const [params] = useSearchParams();
  // A link from the home screen names the list to open (?tab=owed); without
  // one, the tab and filters this browser used last.
  const initial = useMemo(() => {
    const saved = readSavedView();
    const linked = params.get('tab') as TabKey | null;
    return linked && TABS.includes(linked) ? { tab: linked, filters: NO_FILTERS } : saved;
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [tab, setTab] = useState<TabKey>(initial.tab);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({});
  const [owedTotal, setOwedTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrderRow | null>(null);
  const [history, setHistory] = useState<OrderRow | null>(null);
  const [reopening, setReopening] = useState<OrderRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Remember the tab and filters per browser, so the person who always works
  // from "to ship" lands there.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab, filters }));
    } catch {
      // Not worth interrupting anyone over.
    }
  }, [tab, filters]);

  // A new search, tab or filter starts again from the first page.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [tab, filters, search]);

  const load = useCallback(async () => {
    let query: Query = supabase
      .from('v_order_list')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    query = applyFilters(applyTab(query, tab), filters);

    const term = search.trim().replace(/[%,()*]/g, '');
    if (term) {
      // The numbers and names people actually quote down the phone.
      query = query.or(
        [
          `order_number.ilike.%${term}%`,
          `tracking_number.ilike.%${term}%`,
          `customer_phone.ilike.%${term}%`,
          `customer_name.ilike.%${term}%`,
        ].join(','),
      );
    }

    const { data, error: queryError } = await query;
    if (queryError) {
      setError(arabicError(queryError));
      return;
    }
    setError(null);
    const list = (data ?? []) as OrderRow[];
    setHasMore(list.length > limit);
    setRows(list.slice(0, limit));
  }, [tab, filters, search, limit]);

  useEffect(() => {
    // Debounced, so typing an order number does not fire a query per key.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load, reloadToken]);

  // The tab counts are the day's to-do list, so they ignore the search and
  // filters - they always say how many are waiting in each list.
  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      ...TABS.map((key) =>
        applyTab(supabase.from('v_order_list').select('id', { count: 'exact', head: true }), key).then(
          ({ count }: { count: number | null }) => [key, count ?? 0] as const,
        ),
      ),
      applyTab(supabase.from('v_order_list').select('total_egp, shipping_egp'), 'owed').limit(2000),
    ]).then((results) => {
      if (cancelled) return;
      const owed = results.pop() as { data: Array<{ total_egp: number; shipping_egp: number }> | null };
      setCounts(Object.fromEntries(results as Array<readonly [TabKey, number]>));
      setOwedTotal(
        (owed.data ?? []).reduce((sum, row) => sum + Number(row.total_egp) + Number(row.shipping_egp), 0),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const reload = () => setReloadToken((token) => token + 1);

  async function settle(row: OrderRow, rpc: 'mark_order_paid' | 'complete_own_delivery' = 'mark_order_paid') {
    setBusyId(row.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc(rpc, { p_order_id: row.id });
    setBusyId(null);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    reload();
  }

  const activeFilters = Object.values(filters).filter(Boolean).length;

  if (invoiceId) return <Invoice orderId={invoiceId} onClose={() => setInvoiceId(null)} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-extrabold">{t('orders.title')}</h1>
        {owedTotal > 0 ? (
          <button
            type="button"
            onClick={() => setTab('owed')}
            className="tabular rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900"
          >
            {t('orders.owed', { amount: formatEGP(owedTotal, locale) })}
          </button>
        ) : null}
      </div>

      {/* The lists people check every day, each with how many are in it. */}
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex min-w-max gap-1.5">
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cx(
                'flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-bold transition-colors',
                tab === key ? 'bg-duch-ink text-white' : 'text-stone-600 hover:bg-stone-100',
              )}
            >
              {t(`orders.tab.${key}`)}
              {counts[key] !== undefined ? (
                <span
                  className={cx(
                    'tabular rounded-md px-1.5 text-xs',
                    tab === key ? 'bg-duch-accent text-white' : 'bg-stone-100 text-duch-ink',
                  )}
                >
                  {counts[key]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('orders.searchPlaceholder')}
          autoComplete="off"
          inputMode="search"
        />

        {/* One row that scrolls sideways on a phone, rather than three rows
            of filters pushing the orders off the screen. */}
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          <FilterSelect
            value={filters.channel}
            onChange={(channel) => setFilters((f) => ({ ...f, channel }))}
            allLabel={t('orders.filter.channelAll')}
            options={['store', 'online', 'dm'].map((value) => [value, t(`channel.${value}`)])}
          />
          <FilterSelect
            value={filters.method}
            onChange={(method) => setFilters((f) => ({ ...f, method }))}
            allLabel={t('orders.filter.methodAll')}
            options={PAYMENT_METHODS.map((value) => [value, t(`payment.${value}`)])}
          />
          <FilterSelect
            value={filters.paid}
            onChange={(paid) => setFilters((f) => ({ ...f, paid: paid as Filters['paid'] }))}
            allLabel={t('orders.filter.paidAll')}
            options={[
              ['paid', t('paymentStatus.paid')],
              ['unpaid', t('paymentStatus.pending')],
            ]}
          />
          <FilterSelect
            value={filters.delivery}
            onChange={(delivery) => setFilters((f) => ({ ...f, delivery: delivery as Filters['delivery'] }))}
            allLabel={t('orders.filter.deliveryAll')}
            options={[
              ['accurate', t('orders.courier.accurate')],
              ['own', t('orders.courier.own')],
            ]}
          />
          <FilterSelect
            value={filters.period}
            onChange={(period) => setFilters((f) => ({ ...f, period: period as Filters['period'] }))}
            allLabel={t('orders.filter.periodAll')}
            options={[
              ['today', t('reports.preset.today')],
              ['7', t('reports.preset.week')],
              ['30', t('reports.preset.month')],
            ]}
          />
          {activeFilters > 0 ? (
            <Button variant="ghost" className="min-h-9 px-2 text-xs" onClick={() => setFilters(NO_FILTERS)}>
              {t('orders.filter.clear')}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {editing ? (
        <OrderEditor
          order={{
            id: editing.id,
            order_number: editing.order_number,
            channel: editing.channel,
            payment_method: editing.payment_method,
            payment_status: editing.payment_status,
            fulfillment_status: editing.fulfillment_status,
            shipping_egp: editing.shipping_egp,
            discount_egp: editing.discount_egp,
            subtotal_egp: editing.subtotal_egp,
            total_egp: editing.total_egp,
            note: editing.note,
            cancelled_at: editing.cancelled_at,
            customer_id: editing.customer_id,
            customers: { full_name: editing.customer_name, phone: editing.customer_phone },
          }}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}

      {reopening ? (
        <ReopenPaymentDialog
          order={reopening}
          onClose={() => setReopening(null)}
          onDone={() => {
            setReopening(null);
            reload();
          }}
        />
      ) : null}

      {history ? <OrderHistory order={history} onClose={() => setHistory(null)} /> : null}

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('orders.empty')} />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <OrderCard
              key={row.id}
              row={row}
              busy={busyId === row.id}
              maySettle={maySettle}
              mayEdit={mayEdit}
              isOwner={Boolean(identity?.is_owner)}
              onHistory={() => setHistory(row)}
              onEdit={() => setEditing(row)}
              onInvoice={() => setInvoiceId(row.id)}
              onSettle={(rpc) => void settle(row, rpc)}
              onReopen={() => setReopening(row)}
            />
          ))}

          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                {t('orders.more')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: Array<[string, string]>;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cx(
        'min-h-9 shrink-0 rounded-lg border px-2.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-duch-ink/20',
        value ? 'border-duch-ink bg-duch-ink text-white' : 'border-duch-line bg-white text-stone-700',
      )}
    >
      <option value="">{allLabel}</option>
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  );
}

// --- Where an order is now --------------------------------------------------------

function sinceLabel(iso: string, t: (k: string, p?: Record<string, unknown>) => string): string {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return t('orders.since.now');
  if (hours < 48) return t('queue.ageHours', { count: hours });
  return t('queue.ageDays', { count: Math.floor(hours / 24) });
}

function courierName(row: OrderRow, t: (k: string, p?: Record<string, unknown>) => string): string {
  if (row.courier === 'own') return row.driver_name ?? t('orders.courier.own');
  if (row.courier === 'accurate') return t('orders.courier.accurate');
  return row.courier ?? '—';
}

/** The tracker line: where the order is now, in one of the five meanings, and since when. */
function whereNow(
  row: OrderRow,
  t: (k: string, p?: Record<string, unknown>) => string,
): { tone: StatusTone; label: string } {
  const days = (Date.now() - new Date(row.stage_since).getTime()) / 86_400_000;

  switch (row.stage) {
    case 'cancelled':
      return { tone: 'closed', label: t('orders.where.cancelled') };
    case 'to_ship':
      return { tone: 'wait', label: t('orders.where.toShip') };
    case 'on_the_road':
      if (row.courier === 'own') {
        return { tone: 'wait', label: t('orders.where.withDriver', { name: courierName(row, t) }) };
      }
      return days >= COURIER_LATE_DAYS
        ? { tone: 'back', label: t('orders.where.late', { courier: courierName(row, t) }) }
        : { tone: 'road', label: t('orders.where.withCourier', { courier: courierName(row, t) }) };
    case 'delivered':
      return { tone: 'done', label: t('orders.where.delivered') };
    default:
      return {
        tone: row.fulfillment_status === 'returned' ? 'closed' : 'back',
        label: t(`fulfillment.${row.fulfillment_status}`),
      };
  }
}

function OrderCard({
  row,
  busy,
  maySettle,
  mayEdit,
  isOwner,
  onHistory,
  onEdit,
  onInvoice,
  onSettle,
  onReopen,
}: {
  row: OrderRow;
  busy: boolean;
  maySettle: boolean;
  mayEdit: boolean;
  isOwner: boolean;
  onHistory: () => void;
  onEdit: () => void;
  onInvoice: () => void;
  onSettle: (rpc: 'mark_order_paid' | 'complete_own_delivery') => void;
  onReopen: () => void;
}) {
  const { t, locale } = useLocale();
  const totals = calculateInvoiceTotals(row);
  const cancelled = row.cancelled_at !== null;
  // Cancelled, or the goods came back: nothing is owed on it.
  const closed = isClosed(row);
  const where = whereNow(row, t);

  // Out with one of our own drivers: "cash received" records it delivered and
  // paid in one step, so it replaces mark paid there.
  const deliverable =
    maySettle && !cancelled && row.courier === 'own' && row.shipment_status === 'out_for_delivery';
  // Every unpaid order but card, which is paid at the till - the owner's
  // decision, cash on delivery included.
  const settleable =
    maySettle && !closed && !deliverable && row.payment_status === 'pending' && row.payment_method !== 'card';

  return (
    <Card className="space-y-3">
      {/* Number, where it is now, and what it comes to. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Code className="text-lg font-extrabold">{row.order_number}</Code>
            <Badge>{t(`channel.${row.channel}`)}</Badge>
            <span className="text-xs text-stone-500">{formatDateTime(row.created_at, locale)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
            <StatusPill tone={where.tone}>{where.label}</StatusPill>
            {row.stage !== 'cancelled' ? <span>{sinceLabel(row.stage_since, t)}</span> : null}
          </div>
        </div>

        <div className="text-end">
          <p className="tabular text-lg font-extrabold">{formatEGP(totals.payable_egp, locale)}</p>
          <div className="mt-0.5 flex flex-wrap justify-end gap-1.5">
            {closed && row.payment_status === 'pending' ? (
              <StatusPill tone="closed">{t('orders.nothingOwed')}</StatusPill>
            ) : (
              <StatusPill tone={row.payment_status === 'paid' ? 'done' : 'wait'}>
                {t(`paymentStatus.${row.payment_status}`)}
              </StatusPill>
            )}
            {row.payment_method ? (
              <span className="text-xs text-stone-500">{t(`payment.${row.payment_method}`)}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Who and where. */}
        <div className="space-y-0.5 rounded-lg bg-stone-50 px-3 py-2 text-sm">
          <p className="font-bold">
            <bdi>{row.customer_name ?? t('queue.walkIn')}</bdi>
          </p>
          {row.customer_phone ? (
            <a href={`tel:${row.customer_phone}`} className="block text-duch-accent underline">
              <Code>{row.customer_phone}</Code>
            </a>
          ) : null}
          {row.customer_address ? (
            <p className="text-stone-600">
              <bdi>{row.customer_address}</bdi>
            </p>
          ) : null}
        </div>

        {/* The parcel. The shipment number is the one people read off a
            label, so it is the biggest thing here. */}
        <div className="space-y-0.5 rounded-lg bg-stone-50 px-3 py-2 text-sm">
          {row.tracking_number ? (
            <>
              <p className="text-xs text-stone-500">
                {t('orders.shipmentWith', { courier: courierName(row, t) })}
              </p>
              <Code className="block text-base font-extrabold">{row.tracking_number}</Code>
            </>
          ) : row.courier === 'own' ? (
            <>
              <p className="text-xs text-stone-500">{t('orders.courier.own')}</p>
              <p className="font-bold">
                <bdi>{row.driver_name ?? '—'}</bdi>
              </p>
            </>
          ) : row.channel === 'store' ? (
            <p className="text-stone-500">{t('orders.pickedUpInStore')}</p>
          ) : (
            <p className="text-stone-500">{t('orders.noShipment')}</p>
          )}
        </div>
      </div>

      {/* What they took. */}
      <ul className="divide-y divide-duch-line rounded-lg border border-duch-line text-sm">
        {row.items.map((item, index) => (
          <li key={`${item.sku}:${index}`} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                <bdi>{item.title}</bdi>
              </span>
              <span className="block text-xs text-stone-500">
                {item.variant_title ? <bdi>{item.variant_title}</bdi> : null}
                {item.variant_title ? ' · ' : null}
                <Code>{item.sku}</Code>
              </span>
            </span>
            <span className="tabular whitespace-nowrap text-stone-600">
              {item.quantity} × {formatEGP(Number(item.unit_price_egp), locale)}
            </span>
          </li>
        ))}
        <li className="tabular flex flex-wrap justify-end gap-x-4 gap-y-1 bg-stone-50 px-3 py-2 text-xs text-stone-600">
          <span>
            {t('orders.goods')} {formatEGP(totals.subtotal_egp, locale)}
          </span>
          {totals.discount_egp > 0 ? (
            <span>
              {t('sale.discount')} −{formatEGP(totals.discount_egp, locale)}
            </span>
          ) : null}
          <span>
            {t('sale.shipping')} {totals.shipping_egp > 0 ? formatEGP(totals.shipping_egp, locale) : '—'}
          </span>
          <span className="font-bold text-duch-ink">
            {t('sale.total')} {formatEGP(totals.payable_egp, locale)}
          </span>
        </li>
      </ul>

      {row.note ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-bold">{t('orders.noteLabel')}: </span>
          <bdi>{row.note}</bdi>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-duch-line pt-3">
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onHistory}>
          {t('orders.history.open')}
        </Button>
        {/* Editing is offered even on a locked order: the customer's name and
            the note are still correctable, and the editor says which parts
            are fixed. */}
        {mayEdit && !cancelled ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onEdit}>
            {t('orders.edit')}
          </Button>
        ) : null}
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onInvoice}>
          {t('sale.printInvoice')}
        </Button>

        {/* Owner only - the database refuses anyone else. For a payment
            recorded by mistake, which the ordinary editor cannot touch once
            the order is paid. */}
        {isOwner && !cancelled && row.payment_status === 'paid' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onReopen}>
            {t('orders.reopenPayment')}
          </Button>
        ) : null}

        {settleable ? (
          <Button className="ms-auto" disabled={busy} onClick={() => onSettle('mark_order_paid')}>
            {busy ? t('app.loading') : t('orders.markPaid')}
          </Button>
        ) : null}

        {deliverable ? (
          <Button className="ms-auto" disabled={busy} onClick={() => onSettle('complete_own_delivery')}>
            {busy
              ? t('app.loading')
              : row.payment_method === 'cod'
                ? t('queue.cashReceived')
                : t('queue.delivered')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

// --- The tracker: every step, who did it, and when ----------------------------------

interface OrderEvent {
  id: string;
  event_type: string;
  from_fulfillment: string | null;
  to_fulfillment: string | null;
  from_payment: string | null;
  to_payment: string | null;
  note: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  staff: { full_name: string | null } | null;
}

/** One line of history, in words. */
function describeEvent(event: OrderEvent, t: (k: string, p?: Record<string, unknown>) => string): string {
  switch (event.event_type) {
    case 'created':
      return t('orders.history.created');
    case 'confirmation_call': {
      const outcome = event.details?.outcome as string | undefined;
      return t('orders.history.call', { outcome: outcome ? t(`orders.history.outcome.${outcome}`) : '—' });
    }
    case 'fulfillment_change':
      return event.to_fulfillment
        ? t(`orders.history.to.${event.to_fulfillment}`)
        : t('orders.history.statusChanged');
    case 'payment_change':
      return event.to_payment === 'paid'
        ? t('orders.history.paid')
        : t('orders.history.paymentTo', { status: t(`paymentStatus.${event.to_payment ?? 'pending'}`) });
    case 'payment_reopened':
      return t('orders.history.reopened');
    case 'items_edited':
      return t('orders.history.itemsEdited');
    case 'edited':
      return t('orders.history.edited');
    default:
      return event.event_type;
  }
}

function OrderHistory({ order, onClose }: { order: OrderRow; onClose: () => void }) {
  const { t, locale } = useLocale();
  const [events, setEvents] = useState<OrderEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('order_events')
      .select(
        'id, event_type, from_fulfillment, to_fulfillment, from_payment, to_payment, note, details, created_at, staff ( full_name )',
      )
      .eq('order_id', order.id)
      .order('created_at', { ascending: false })
      .then(({ data, error: queryError }) => {
        if (cancelled) return;
        if (queryError) setError(arabicError(queryError));
        else setEvents((data ?? []) as unknown as OrderEvent[]);
      });
    return () => {
      cancelled = true;
    };
  }, [order.id]);

  const where = whereNow(order, t);
  const paid = order.payment_status === 'paid';
  const closed = isClosed(order);
  const bornDelivered = order.channel === 'store';

  // The steps an order goes through, ticked as far as it has got.
  type Step = { label: string; state: 'done' | 'now' | 'todo' | 'problem' };
  const steps: Step[] = bornDelivered
    ? [
        { label: t('orders.step.sold'), state: 'done' },
        {
          label: closed ? t('orders.nothingOwed') : t('orders.step.paid'),
          state: paid ? 'done' : closed ? 'problem' : 'now',
        },
      ]
    : [
        { label: t('orders.step.ordered'), state: 'done' },
        {
          label: t('orders.step.out'),
          state: order.stage === 'to_ship' ? 'now' : order.stage === 'cancelled' ? 'todo' : 'done',
        },
        {
          label: order.stage === 'back' ? t(`fulfillment.${order.fulfillment_status}`) : t('orders.step.delivered'),
          state:
            order.stage === 'delivered'
              ? 'done'
              : order.stage === 'back'
                ? 'problem'
                : order.stage === 'on_the_road'
                  ? 'now'
                  : 'todo',
        },
        {
          label: closed ? t('orders.nothingOwed') : t('orders.step.paid'),
          state: paid ? 'done' : closed ? 'problem' : order.stage === 'delivered' ? 'now' : 'todo',
        },
      ];

  const STEP_BAR: Record<Step['state'], string> = {
    done: 'bg-emerald-600',
    now: 'bg-blue-600 animate-pulse',
    todo: 'bg-duch-line',
    problem: 'bg-red-500',
  };

  return (
    <Modal open title={t('orders.history.title', { orderNumber: order.order_number })} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
          <StatusPill tone={where.tone}>{where.label}</StatusPill>
          {order.stage !== 'cancelled' ? <span>{sinceLabel(order.stage_since, t)}</span> : null}
        </div>

        <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((step) => (
            <li key={step.label} className="space-y-1">
              <span className={cx('block h-1.5 rounded-full', STEP_BAR[step.state])} />
              <span
                className={cx(
                  'block text-xs font-semibold',
                  step.state === 'todo' ? 'text-stone-400' : 'text-duch-ink',
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>

        {order.tracking_number || order.courier === 'own' ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <p className="text-xs text-stone-500">{t('orders.shipmentWith', { courier: courierName(order, t) })}</p>
              {order.tracking_number ? (
                <Code className="font-bold">{order.tracking_number}</Code>
              ) : (
                <p className="font-bold">—</p>
              )}
            </div>
            <div className="rounded-lg bg-stone-50 px-3 py-2">
              <p className="text-xs text-stone-500">{t('orders.handedOver')}</p>
              <p className="tabular font-bold">
                {order.handed_over_at ? formatDateTime(order.handed_over_at, locale) : '—'}
              </p>
            </div>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {!events ? (
          <Spinner />
        ) : (
          <ol className="relative space-y-3 border-s-2 border-duch-line ps-4">
            {events.map((event) => (
              <li key={event.id} className="relative">
                <span className="absolute -start-[1.4rem] top-1.5 size-2.5 rounded-full bg-duch-ink ring-4 ring-white" />
                <p className="text-sm font-semibold">{describeEvent(event, t)}</p>
                {event.note ? (
                  <p className="text-xs text-stone-600">
                    <bdi>{event.note}</bdi>
                  </p>
                ) : null}
                <p className="text-xs text-stone-500">
                  {formatDateTime(event.created_at, locale)}
                  {event.staff?.full_name ? (
                    <>
                      {' · '}
                      <bdi>{event.staff.full_name}</bdi>
                    </>
                  ) : (
                    <> · {t('orders.history.system')}</>
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

// --- Reopening a payment recorded by mistake ---------------------------------

function ReopenPaymentDialog({
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
