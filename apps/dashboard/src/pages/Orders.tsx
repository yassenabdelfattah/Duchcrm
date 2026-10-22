import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import {
  PAYMENT_METHODS,
  can,
  canAny,
  calculateInvoiceTotals,
  formatDateTime,
  formatEGP,
  type PaymentMethod,
} from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { useSearchParams } from 'react-router';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { sendOrderToShopify } from '../lib/shopifySync';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
import {
  Badge,
  Button,
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
import { ExchangeDialog } from '../components/ExchangeDialog';

/**
 * Every order, findable, and each one a line until it is needed.
 *
 * The owner's asks: an order shows all of itself - customer, address, the
 * shipment number, what they took, shipping, the note, where it is and for
 * how long (2026-10-04) - and the list is organised the way Shopify's is
 * (2026-10-23): one line per order with its next step as a button, tap to
 * open the rest; tick several and settle them together; lists with counts,
 * filters added as chips, and finished orders moved to an archive by
 * themselves.
 *
 * It reads v_order_list, which flattens all of that into one row per order
 * and says whether anything is left to do on it (is_closed).
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
  /** Set on an order that came from the website. */
  shopify_order_id: number | null;
  /** A change made here has not reached Shopify yet. */
  shopify_pending: boolean;
  /** On a replacement: the order it was exchanged from. */
  exchange_for_order_id: string | null;
  exchange_for_order_number: string | null;
  /** On a replacement that cost less: owed back to the customer. */
  exchange_refund_egp: number;
  exchange_refunded_at: string | null;
  /** On an original: the replacements made for it. */
  exchanged_in: string | null;
  /** Nothing left to do on it: it lives in the archive. */
  is_closed: boolean;
  customer_governorate: string | null;
}

type SettleAction = 'mark_order_paid' | 'complete_own_delivery' | 'mark_courier_delivered' | 'mark_exchange_refunded';

const PAGE_SIZE = 50;

/** A parcel with the courier this long is late - the same line the custody report draws. */
const COURIER_LATE_DAYS = 7;

// --- Lists, filters and order -----------------------------------------------------

type TabKey = 'open' | 'to_ship' | 'on_the_road' | 'late' | 'owed' | 'back' | 'archive';
const TABS: TabKey[] = ['open', 'to_ship', 'on_the_road', 'late', 'owed', 'back', 'archive'];

interface Filters {
  channel: string;
  method: string;
  paid: '' | 'paid' | 'unpaid';
  delivery: '' | 'accurate' | 'own';
  period: '' | 'today' | '7' | '30' | 'range';
  /** yyyy-mm-dd, for period "range". */
  from: string;
  to: string;
  governorate: string;
  exchange: boolean;
  hasNote: boolean;
}

const NO_FILTERS: Filters = {
  channel: '',
  method: '',
  paid: '',
  delivery: '',
  period: '',
  from: '',
  to: '',
  governorate: '',
  exchange: false,
  hasNote: false,
};

type SortKey = 'newest' | 'oldest' | 'value' | 'waiting';
const SORTS: SortKey[] = ['newest', 'oldest', 'value', 'waiting'];

const STORAGE_KEY = 'duch.orders.view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST builder's generics are not worth spelling out here
type Query = any;

/**
 * Narrows a query to one list. "Owed" is delivered and not paid: the
 * customer has it, we do not have the money. "Late" is the same seven days
 * the custody report and the home screen use.
 */
function applyTab(query: Query, tab: TabKey): Query {
  switch (tab) {
    case 'open':
      return query.eq('is_closed', false);
    case 'to_ship':
    case 'on_the_road':
      return query.eq('stage', tab);
    case 'late':
      return query
        .eq('stage', 'on_the_road')
        .neq('courier', 'own')
        .lt('stage_since', new Date(Date.now() - COURIER_LATE_DAYS * 86_400_000).toISOString());
    case 'owed':
      return query.eq('stage', 'delivered').eq('payment_status', 'pending');
    case 'back':
      return query.eq('stage', 'back').eq('is_closed', false);
    case 'archive':
      return query.eq('is_closed', true);
  }
}

function applyFilters(query: Query, filters: Filters): Query {
  let q = query;
  if (filters.channel) q = q.eq('channel', filters.channel);
  if (filters.method) q = q.eq('payment_method', filters.method);
  if (filters.paid === 'paid') q = q.eq('payment_status', 'paid');
  if (filters.paid === 'unpaid') q = q.eq('payment_status', 'pending');
  if (filters.delivery) q = q.eq('courier', filters.delivery);
  if (filters.governorate) q = q.eq('customer_governorate', filters.governorate);
  if (filters.exchange) q = q.not('exchange_for_order_id', 'is', null);
  if (filters.hasNote) q = q.not('note', 'is', null);
  if (filters.period === 'range') {
    if (filters.from) q = q.gte('created_at', new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) {
      const end = new Date(`${filters.to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      q = q.lt('created_at', end.toISOString());
    }
  } else if (filters.period) {
    const since = new Date();
    if (filters.period === 'today') since.setHours(0, 0, 0, 0);
    else since.setDate(since.getDate() - Number(filters.period));
    q = q.gte('created_at', since.toISOString());
  }
  return q;
}

function applySort(query: Query, sort: SortKey): Query {
  switch (sort) {
    case 'oldest':
      return query.order('created_at', { ascending: true });
    case 'value':
      return query.order('total_egp', { ascending: false }).order('created_at', { ascending: false });
    case 'waiting':
      return query.order('stage_since', { ascending: true });
    default:
      return query.order('created_at', { ascending: false });
  }
}

function readSavedView(): { tab: TabKey; filters: Filters; sort: SortKey } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      tab?: string;
      filters?: Partial<Filters>;
      sort?: SortKey;
    } | null;
    if (saved) {
      // "all" was the first list before the archive existed.
      const tab = saved.tab === 'all' ? 'open' : (saved.tab as TabKey);
      return {
        tab: TABS.includes(tab) ? tab : 'open',
        filters: { ...NO_FILTERS, ...saved.filters },
        sort: SORTS.includes(saved.sort as SortKey) ? (saved.sort as SortKey) : 'newest',
      };
    }
  } catch {
    // Private browsing or a corrupt value: start from the defaults.
  }
  return { tab: 'open', filters: NO_FILTERS, sort: 'newest' };
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

interface Permissions {
  maySettle: boolean;
  mayEdit: boolean;
  mayDeliver: boolean;
  mayCancel: boolean;
  mayExchange: boolean;
  isOwner: boolean;
}

/**
 * Which of the money and delivery steps an order offers this person. One
 * place, so the row's button, the opened order and the bulk actions agree.
 */
function stepsFor(row: OrderRow, p: Permissions) {
  const cancelled = row.cancelled_at !== null;
  // Out with one of our own drivers: "cash received" records it delivered and
  // paid in one step, so it replaces mark paid there.
  const deliverable =
    p.maySettle && !cancelled && row.courier === 'own' && row.shipment_status === 'out_for_delivery';
  // With a courier and the customer has it: delivered, while the courier
  // still holds the cash. The payment is left for their statement.
  const courierDelivered =
    p.mayDeliver && !cancelled && row.stage === 'on_the_road' && row.courier !== null && row.courier !== 'own';
  // Every unpaid order but card, which is paid at the till - the owner's
  // decision, cash on delivery included.
  const settleable =
    p.maySettle && !isClosed(row) && !deliverable && row.payment_status === 'pending' && row.payment_method !== 'card';
  const refundOwed = p.maySettle && Number(row.exchange_refund_egp) > 0 && !row.exchange_refunded_at;
  return { cancelled, deliverable, courierDelivered, settleable, refundOwed };
}

/** The one step shown on the line itself: what this order is waiting for. */
function nextStep(
  row: OrderRow,
  p: Permissions,
  t: (k: string, v?: Record<string, unknown>) => string,
): { rpc: SettleAction; label: string } | null {
  const steps = stepsFor(row, p);
  if (steps.deliverable) {
    return {
      rpc: 'complete_own_delivery',
      label: row.payment_method === 'cod' ? t('queue.cashReceived') : t('queue.delivered'),
    };
  }
  if (steps.courierDelivered) return { rpc: 'mark_courier_delivered', label: t('orders.customerReceived') };
  if (steps.settleable && row.stage === 'delivered') return { rpc: 'mark_order_paid', label: t('orders.markPaid') };
  if (steps.refundOwed) return { rpc: 'mark_exchange_refunded', label: t('exchange.markRefunded') };
  return null;
}

/** What the customer pays: goods after discount, plus shipping. */
const payable = (row: OrderRow) => Number(row.total_egp) + Number(row.shipping_egp);

type BulkAction = 'mark_order_paid' | 'mark_courier_delivered';

export function Orders() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const perms: Permissions = {
    maySettle: can(identity?.permissions, 'orders.settle'),
    mayEdit: can(identity?.permissions, 'orders.edit'),
    mayDeliver: canAny(identity?.permissions, ['orders.settle', 'orders.ship']),
    mayCancel: can(identity?.permissions, 'orders.cancel'),
    // An exchange edits an order, takes a return and rings up a replacement.
    mayExchange:
      can(identity?.permissions, 'orders.edit') &&
      can(identity?.permissions, 'returns.manage') &&
      can(identity?.permissions, 'sales.create'),
    isOwner: Boolean(identity?.is_owner),
  };
  const maySelect = perms.maySettle || perms.mayDeliver;

  const [params] = useSearchParams();
  // A link from the home screen names the list to open (?tab=owed); without
  // one, the list, filters and order this browser used last.
  const initial = useMemo(() => {
    const saved = readSavedView();
    const linked = params.get('tab') as TabKey | null;
    return linked && TABS.includes(linked) ? { ...saved, tab: linked, filters: NO_FILTERS } : saved;
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [tab, setTab] = useState<TabKey>(initial.tab);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [sort, setSort] = useState<SortKey>(initial.sort);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({});
  const [owedTotal, setOwedTotal] = useState(0);
  const [governorates, setGovernorates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bulk, setBulk] = useState<BulkAction | null>(null);

  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrderRow | null>(null);
  const [history, setHistory] = useState<OrderRow | null>(null);
  const [reopening, setReopening] = useState<OrderRow | null>(null);
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  const [exchanging, setExchanging] = useState<OrderRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Remember the list, filters and order per browser, so the person who
  // always works from "owed" lands there.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab, filters, sort }));
    } catch {
      // Not worth interrupting anyone over.
    }
  }, [tab, filters, sort]);

  const term = search.trim().replace(/[%,()*]/g, '');

  // A new list, filter, order or search starts again from the top, with
  // nothing ticked and nothing open.
  useEffect(() => {
    setLimit(PAGE_SIZE);
    setSelected(new Set());
    setExpanded(null);
  }, [tab, filters, sort, term]);

  const load = useCallback(async () => {
    let query: Query = supabase.from('v_order_list').select('*').limit(limit + 1);
    query = applySort(query, sort);
    // A search looks through every order, archive included: someone quoting
    // a number down the phone does not know which list it is in.
    if (!term) query = applyTab(query, tab);
    query = applyFilters(query, filters);

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
  }, [tab, filters, sort, term, limit]);

  useEffect(() => {
    // Debounced, so typing an order number does not fire a query per key.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load, reloadToken]);

  // The counts are the day's to-do list, so they ignore the search and
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

  // The governorates customers have actually ordered from, for the filter.
  useEffect(() => {
    supabase
      .from('v_order_list')
      .select('customer_governorate')
      .not('customer_governorate', 'is', null)
      .limit(5000)
      .then(({ data }) => {
        const names = new Set(
          ((data ?? []) as Array<{ customer_governorate: string | null }>)
            .map((row) => row.customer_governorate?.trim())
            .filter((name): name is string => Boolean(name)),
        );
        setGovernorates([...names].sort((a, b) => a.localeCompare(b, 'ar')));
      });
  }, []);

  const reload = () => setReloadToken((token) => token + 1);

  async function settle(row: OrderRow, rpc: SettleAction = 'mark_order_paid') {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc(rpc, { p_order_id: row.id });
    setBusyId(null);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    reload();
  }

  const selectedRows = (rows ?? []).filter((row) => selected.has(row.id));
  const eligible = (action: BulkAction) =>
    selectedRows.filter((row) => {
      const steps = stepsFor(row, perms);
      return action === 'mark_order_paid' ? steps.settleable : steps.courierDelivered;
    });
  const allSelected = Boolean(rows?.length) && selectedRows.length === rows?.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set((rows ?? []).map((row) => row.id)));
  }

  const activeFilters = activeFilterChips(filters, t);

  if (invoiceId) return <Invoice orderId={invoiceId} onClose={() => setInvoiceId(null)} />;

  return (
    <div className={cx('space-y-4', selected.size > 0 && 'pb-20 sm:pb-0')}>
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
              onClick={() => {
                setTab(key);
                setSearch('');
              }}
              className={cx(
                'flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-bold transition-colors',
                tab === key && !term ? 'bg-duch-ink text-white' : 'text-stone-600 hover:bg-stone-100',
              )}
            >
              {t(`orders.tab.${key}`)}
              {counts[key] !== undefined && key !== 'archive' ? (
                <span
                  className={cx(
                    'tabular rounded-md px-1.5 text-xs',
                    tab === key && !term ? 'bg-duch-accent text-white' : 'bg-stone-100 text-duch-ink',
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
        <div className="flex gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('orders.searchPlaceholder')}
            autoComplete="off"
            inputMode="search"
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className={cx(
              'flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-bold',
              activeFilters.length > 0
                ? 'border-duch-ink bg-duch-ink text-white'
                : 'border-duch-line bg-white text-duch-ink hover:bg-stone-50',
            )}
          >
            <SlidersHorizontal className="size-4" />
            <span className="hidden sm:inline">{t('orders.filters')}</span>
            {activeFilters.length > 0 ? <span className="tabular">{activeFilters.length}</span> : null}
          </button>
        </div>

        {/* What is narrowing the list, each removable on its own. */}
        {activeFilters.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilters.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFilters((f) => ({ ...f, ...chip.clear }))}
                className="flex min-h-8 items-center gap-1 rounded-full bg-stone-100 px-3 text-xs font-semibold text-duch-ink hover:bg-stone-200"
              >
                {chip.label}
                <X className="size-3.5" aria-label={t('orders.filter.remove')} />
              </button>
            ))}
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="min-h-8 px-2 text-xs font-semibold text-stone-500 underline"
            >
              {t('orders.filter.clear')}
            </button>
          </div>
        ) : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">{notice}</p>
      ) : null}

      {exchanging ? (
        <ExchangeDialog
          order={{
            id: exchanging.id,
            order_number: exchanging.order_number,
            subtotal_egp: exchanging.subtotal_egp,
            total_egp: exchanging.total_egp,
            shipping_egp: exchanging.shipping_egp,
          }}
          onClose={() => setExchanging(null)}
          onDone={(result) => {
            setExchanging(null);
            setNotice(
              result.refund_due_egp > 0
                ? t(result.in_store ? 'exchange.doneRefundShop' : 'exchange.doneRefund', {
                    orderNumber: result.replacement_order_number,
                    amount: formatEGP(result.refund_due_egp, locale),
                  })
                : t('exchange.done', {
                    orderNumber: result.replacement_order_number,
                    amount: formatEGP(result.amount_due_egp, locale),
                  }),
            );
            reload();
          }}
        />
      ) : null}

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
            shopify_order_id: editing.shopify_order_id,
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

      {cancelling ? (
        <CancelOrderDialog
          order={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            reload();
          }}
        />
      ) : null}

      {filtersOpen ? (
        <FilterSheet
          filters={filters}
          sort={sort}
          governorates={governorates}
          onChange={setFilters}
          onSort={setSort}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}

      {bulk ? (
        <BulkDialog
          action={bulk}
          rows={eligible(bulk)}
          skipped={selectedRows.length - eligible(bulk).length}
          onClose={() => setBulk(null)}
          onDone={(message) => {
            setBulk(null);
            setSelected(new Set());
            setNotice(message);
            reload();
          }}
        />
      ) : null}

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : (
        <div className="space-y-2">
          {/* The line above the list: what is shown, ticking all of it, and
              the order it is in. */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
            {maySelect && rows.length > 0 ? (
              <label className="flex min-h-9 items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  className="size-5 accent-duch-ink"
                  checked={allSelected}
                  onChange={toggleAll}
                />
                {t('orders.bulk.selectAll')}
              </label>
            ) : null}
            {term ? <span>{t('orders.searchAll')}</span> : null}
            <label className="ms-auto flex items-center gap-1.5">
              <span>{t('orders.sortLabel')}</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                className="min-h-9 rounded-lg border border-duch-line bg-white px-2 text-xs font-semibold text-duch-ink"
              >
                {SORTS.map((key) => (
                  <option key={key} value={key}>
                    {t(`orders.sort.${key}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {rows.length === 0 ? (
            <EmptyState title={tab === 'archive' && !term ? t('orders.emptyArchive') : t('orders.empty')} />
          ) : (
            <ul className="overflow-hidden rounded-xl border border-duch-line bg-white">
              {rows.map((row) => (
                <OrderLine
                  key={row.id}
                  row={row}
                  step={nextStep(row, perms, t)}
                  busy={busyId === row.id}
                  selectable={maySelect}
                  selected={selected.has(row.id)}
                  expanded={expanded === row.id}
                  onSelect={(on) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (on) next.add(row.id);
                      else next.delete(row.id);
                      return next;
                    })
                  }
                  onToggle={() => setExpanded((current) => (current === row.id ? null : row.id))}
                  onStep={(rpc) => void settle(row, rpc)}
                >
                  <OrderDetails
                    row={row}
                    busy={busyId === row.id}
                    perms={perms}
                    onHistory={() => setHistory(row)}
                    onEdit={() => setEditing(row)}
                    onInvoice={() => setInvoiceId(row.id)}
                    onSettle={(rpc) => void settle(row, rpc)}
                    onReopen={() => setReopening(row)}
                    onCancel={() => setCancelling(row)}
                    onExchange={() => {
                      setNotice(null);
                      setExchanging(row);
                    }}
                  />
                </OrderLine>
              ))}
            </ul>
          )}

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                {t('orders.more')}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {/* Several ticked: what can be done to all of them at once. On a phone it
          sits just above the bottom menu, within reach of the thumb. */}
      {selected.size > 0 ? (
        <div
          className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] z-30 flex flex-wrap items-center gap-2 rounded-xl border border-duch-line bg-white p-2 shadow-lg sm:sticky sm:inset-x-auto sm:bottom-4"
        >
          <span className="tabular px-2 text-sm font-bold">
            {t('orders.bulk.selected', { count: selected.size })}
          </span>
          <span className="tabular text-xs text-stone-500">
            {formatEGP(selectedRows.reduce((sum, row) => sum + payable(row), 0), locale)}
          </span>
          <div className="ms-auto flex flex-wrap gap-2">
            {eligible('mark_order_paid').length > 0 ? (
              <Button className="min-h-10 px-3 text-xs" onClick={() => setBulk('mark_order_paid')}>
                {t('orders.bulk.markPaid', { count: eligible('mark_order_paid').length })}
              </Button>
            ) : null}
            {eligible('mark_courier_delivered').length > 0 ? (
              <Button
                variant="secondary"
                className="min-h-10 px-3 text-xs"
                onClick={() => setBulk('mark_courier_delivered')}
              >
                {t('orders.bulk.received', { count: eligible('mark_courier_delivered').length })}
              </Button>
            ) : null}
            {eligible('mark_order_paid').length === 0 && eligible('mark_courier_delivered').length === 0 ? (
              <span className="px-2 text-xs text-stone-500">{t('orders.bulk.none')}</span>
            ) : null}
            <button
              type="button"
              aria-label={t('orders.bulk.clear')}
              onClick={() => setSelected(new Set())}
              className="flex size-10 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- One order, as a line -----------------------------------------------------------

function OrderLine({
  row,
  step,
  busy,
  selectable,
  selected,
  expanded,
  onSelect,
  onToggle,
  onStep,
  children,
}: {
  row: OrderRow;
  step: { rpc: SettleAction; label: string } | null;
  busy: boolean;
  selectable: boolean;
  selected: boolean;
  expanded: boolean;
  onSelect: (on: boolean) => void;
  onToggle: () => void;
  onStep: (rpc: SettleAction) => void;
  children: ReactNode;
}) {
  const { t, locale } = useLocale();
  const where = whereNow(row, t);
  const owesNothing = isClosed(row) && row.payment_status === 'pending';

  return (
    <li className={cx('border-b border-duch-line last:border-b-0', selected && 'bg-sky-50/60')}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-stone-50"
      >
        {selectable ? (
          <input
            type="checkbox"
            className="size-5 shrink-0 accent-duch-ink"
            checked={selected}
            aria-label={t('orders.bulk.selectOne', { orderNumber: row.order_number })}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onSelect(event.target.checked)}
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Code className="shrink-0 font-extrabold">{row.order_number}</Code>
            <span className="truncate text-sm">
              <bdi>{row.customer_name ?? t('queue.walkIn')}</bdi>
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-600">
            <StatusPill tone={where.tone}>{where.label}</StatusPill>
            {row.stage !== 'cancelled' ? <span>{sinceLabel(row.stage_since, t)}</span> : null}
            {owesNothing ? null : row.payment_status === 'paid' ? (
              <span className="font-semibold text-emerald-700">{t('paymentStatus.paid')}</span>
            ) : row.payment_status === 'pending' ? (
              <span className="font-semibold text-amber-700">{t('paymentStatus.pending')}</span>
            ) : (
              <span>{t(`paymentStatus.${row.payment_status}`)}</span>
            )}
            {row.exchange_for_order_number ? (
              <span className="font-semibold text-sky-800">{t('exchange.badge')}</span>
            ) : null}
            {row.shopify_pending ? <span className="text-amber-700">{t('orders.shopifyPending')}</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="tabular text-sm font-extrabold">{formatEGP(payable(row), locale)}</span>
          {step ? (
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onStep(step.rpc);
              }}
            >
              {busy ? t('app.loading') : step.label}
            </Button>
          ) : null}
        </div>

        <ChevronDown
          className={cx('size-4 shrink-0 text-stone-400 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </div>

      {expanded ? <div className="border-t border-duch-line bg-stone-50/50 px-3 pb-4 pt-3">{children}</div> : null}
    </li>
  );
}

// --- Filters ----------------------------------------------------------------------------

interface Chip {
  key: string;
  label: string;
  clear: Partial<Filters>;
}

function activeFilterChips(filters: Filters, t: (k: string, v?: Record<string, unknown>) => string): Chip[] {
  const chips: Chip[] = [];
  if (filters.channel) {
    chips.push({ key: 'channel', label: t(`channel.${filters.channel}`), clear: { channel: '' } });
  }
  if (filters.method) {
    chips.push({ key: 'method', label: t(`payment.${filters.method}`), clear: { method: '' } });
  }
  if (filters.paid) {
    chips.push({
      key: 'paid',
      label: filters.paid === 'paid' ? t('paymentStatus.paid') : t('paymentStatus.pending'),
      clear: { paid: '' },
    });
  }
  if (filters.delivery) {
    chips.push({ key: 'delivery', label: t(`orders.courier.${filters.delivery}`), clear: { delivery: '' } });
  }
  if (filters.governorate) {
    chips.push({ key: 'governorate', label: filters.governorate, clear: { governorate: '' } });
  }
  if (filters.period === 'range' && (filters.from || filters.to)) {
    chips.push({
      key: 'period',
      label: t('orders.filter.rangeChip', { from: filters.from || '…', to: filters.to || '…' }),
      clear: { period: '', from: '', to: '' },
    });
  } else if (filters.period && filters.period !== 'range') {
    const label = { today: 'reports.preset.today', '7': 'reports.preset.week', '30': 'reports.preset.month' }[
      filters.period
    ];
    chips.push({ key: 'period', label: t(label), clear: { period: '' } });
  }
  if (filters.exchange) chips.push({ key: 'exchange', label: t('orders.filter.exchange'), clear: { exchange: false } });
  if (filters.hasNote) chips.push({ key: 'hasNote', label: t('orders.filter.hasNote'), clear: { hasNote: false } });
  return chips;
}

function FilterSheet({
  filters,
  sort,
  governorates,
  onChange,
  onSort,
  onClose,
}: {
  filters: Filters;
  sort: SortKey;
  governorates: string[];
  onChange: (filters: Filters) => void;
  onSort: (sort: SortKey) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  const pick = (
    label: string,
    value: string,
    allLabel: string,
    options: Array<[string, string]>,
    onPick: (value: string) => void,
  ) => (
    <Field label={label}>
      <Select value={value} onChange={(event) => onPick(event.target.value)}>
        <option value="">{allLabel}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Modal open title={t('orders.filters')} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {pick(
            t('orders.filter.label.channel'),
            filters.channel,
            t('orders.filter.channelAll'),
            ['store', 'online', 'dm'].map((value) => [value, t(`channel.${value}`)]),
            (channel) => set({ channel }),
          )}
          {pick(
            t('orders.filter.label.method'),
            filters.method,
            t('orders.filter.methodAll'),
            PAYMENT_METHODS.map((value) => [value, t(`payment.${value}`)]),
            (method) => set({ method }),
          )}
          {pick(
            t('orders.filter.label.paid'),
            filters.paid,
            t('orders.filter.paidAll'),
            [
              ['paid', t('paymentStatus.paid')],
              ['unpaid', t('paymentStatus.pending')],
            ],
            (paid) => set({ paid: paid as Filters['paid'] }),
          )}
          {pick(
            t('orders.filter.label.delivery'),
            filters.delivery,
            t('orders.filter.deliveryAll'),
            [
              ['accurate', t('orders.courier.accurate')],
              ['own', t('orders.courier.own')],
            ],
            (delivery) => set({ delivery: delivery as Filters['delivery'] }),
          )}
          {pick(
            t('orders.filter.label.governorate'),
            filters.governorate,
            t('orders.filter.governorateAll'),
            governorates.map((name) => [name, name]),
            (governorate) => set({ governorate }),
          )}
          {pick(
            t('orders.filter.label.period'),
            filters.period,
            t('orders.filter.periodAll'),
            [
              ['today', t('reports.preset.today')],
              ['7', t('reports.preset.week')],
              ['30', t('reports.preset.month')],
              ['range', t('orders.filter.range')],
            ],
            (period) => set({ period: period as Filters['period'], ...(period === 'range' ? {} : { from: '', to: '' }) }),
          )}
        </div>

        {filters.period === 'range' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('orders.filter.from')}>
              <Input type="date" value={filters.from} onChange={(event) => set({ from: event.target.value })} />
            </Field>
            <Field label={t('orders.filter.to')}>
              <Input type="date" value={filters.to} onChange={(event) => set({ to: event.target.value })} />
            </Field>
          </div>
        ) : null}

        <div className="space-y-2">
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-duch-line px-3 text-sm font-semibold">
            <input
              type="checkbox"
              className="size-5 accent-duch-ink"
              checked={filters.exchange}
              onChange={(event) => set({ exchange: event.target.checked })}
            />
            {t('orders.filter.exchange')}
          </label>
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-duch-line px-3 text-sm font-semibold">
            <input
              type="checkbox"
              className="size-5 accent-duch-ink"
              checked={filters.hasNote}
              onChange={(event) => set({ hasNote: event.target.checked })}
            />
            {t('orders.filter.hasNote')}
          </label>
        </div>

        <Field label={t('orders.sortLabel')}>
          <Select value={sort} onChange={(event) => onSort(event.target.value as SortKey)}>
            {SORTS.map((key) => (
              <option key={key} value={key}>
                {t(`orders.sort.${key}`)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => onChange(NO_FILTERS)}>
            {t('orders.filter.clear')}
          </Button>
          <Button onClick={onClose}>{t('orders.filter.done')}</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Several at once ------------------------------------------------------------------

/**
 * Marks the ticked orders paid, or received, one after another - each through
 * the same database function a single tap uses, so the same rules apply.
 * Says first how many and how much, and afterwards which, if any, were
 * refused and why.
 */
function BulkDialog({
  action,
  rows,
  skipped,
  onClose,
  onDone,
}: {
  action: BulkAction;
  rows: OrderRow[];
  skipped: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t, locale } = useLocale();
  const [done, setDone] = useState<number | null>(null);
  const total = rows.reduce((sum, row) => sum + payable(row), 0);

  async function run() {
    const failures: string[] = [];
    let ok = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      setDone(index);
      const { error } = await supabase.rpc(action, { p_order_id: row.id });
      if (error) failures.push(`${row.order_number}: ${arabicError(error)}`);
      else ok += 1;
    }
    const message = t(action === 'mark_order_paid' ? 'orders.bulk.donePaid' : 'orders.bulk.doneReceived', {
      count: ok,
    });
    onDone(
      failures.length > 0
        ? `${message} ${t('orders.bulk.failed', { count: failures.length, list: failures.join(' · ') })}`
        : message,
    );
  }

  return (
    <Modal
      open
      title={t(action === 'mark_order_paid' ? 'orders.bulk.confirmPaidTitle' : 'orders.bulk.confirmReceivedTitle', {
        count: rows.length,
      })}
      onClose={done === null ? onClose : () => undefined}
    >
      <div className="space-y-3">
        <p className="tabular flex flex-wrap gap-x-2 gap-y-1 rounded-lg bg-stone-50 px-3 py-2 text-xs">
          {rows.map((row) => (
            <Code key={row.id}>{row.order_number}</Code>
          ))}
        </p>
        {action === 'mark_order_paid' ? (
          <p className="tabular text-base font-extrabold">{t('orders.bulk.total', { amount: formatEGP(total, locale) })}</p>
        ) : null}
        {skipped > 0 ? <p className="text-xs text-stone-500">{t('orders.bulk.skipped', { count: skipped })}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={done !== null}>
            {t('orders.keepOrder')}
          </Button>
          <Button onClick={() => void run()} disabled={done !== null}>
            {done !== null
              ? t('orders.bulk.progress', { done: done + 1, count: rows.length })
              : t('orders.bulk.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
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

/** An order opened from its line: everything about it, and every step it offers. */
function OrderDetails({
  row,
  busy,
  perms,
  onHistory,
  onEdit,
  onInvoice,
  onSettle,
  onReopen,
  onCancel,
  onExchange,
}: {
  row: OrderRow;
  busy: boolean;
  perms: Permissions;
  onHistory: () => void;
  onEdit: () => void;
  onInvoice: () => void;
  onSettle: (rpc: SettleAction) => void;
  onReopen: () => void;
  onCancel: () => void;
  onExchange: () => void;
}) {
  const { t, locale } = useLocale();
  const totals = calculateInvoiceTotals(row);
  const { cancelled, deliverable, courierDelivered, settleable } = stepsFor(row, perms);
  // Cancelled, or the goods came back: nothing is owed on it.
  const closed = isClosed(row);

  return (
    <div className="space-y-3">
      {/* Where it came from, when, and how it is paid. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-600">
        <Badge>{t(`channel.${row.channel}`)}</Badge>
        <span>{formatDateTime(row.created_at, locale)}</span>
        {closed && row.payment_status === 'pending' ? (
          <StatusPill tone="closed">{t('orders.nothingOwed')}</StatusPill>
        ) : (
          <StatusPill tone={row.payment_status === 'paid' ? 'done' : 'wait'}>
            {t(`paymentStatus.${row.payment_status}`)}
          </StatusPill>
        )}
        {row.payment_method ? <span>{t(`payment.${row.payment_method}`)}</span> : null}
      </div>
      {row.exchange_for_order_number ? (
        <p className="text-xs font-semibold text-sky-800">
          {t('exchange.forOrder', { orderNumber: row.exchange_for_order_number })}
        </p>
      ) : null}
      {row.exchanged_in ? (
        <p className="text-xs text-sky-800">{t('exchange.exchangedIn', { orderNumbers: row.exchanged_in })}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Who and where. */}
        <div className="space-y-0.5 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-duch-line">
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
        <div className="space-y-0.5 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-duch-line">
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
      <ul className="divide-y divide-duch-line rounded-lg bg-white text-sm ring-1 ring-duch-line">
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
              {row.exchange_for_order_id ? t('exchange.credit') : t('sale.discount')} −
              {formatEGP(totals.discount_egp, locale)}
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

      {Number(row.exchange_refund_egp) > 0 ? (
        row.exchange_refunded_at ? (
          <p className="text-xs text-stone-500">
            {t('exchange.refunded', { amount: formatEGP(Number(row.exchange_refund_egp), locale) })}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="flex-1 font-bold">
              {t('exchange.owedBack', { amount: formatEGP(Number(row.exchange_refund_egp), locale) })}
            </span>
            {perms.maySettle ? (
              <Button
                variant="secondary"
                className="min-h-9 px-3 text-xs"
                disabled={busy}
                onClick={() => onSettle('mark_exchange_refunded')}
              >
                {t('exchange.markRefunded')}
              </Button>
            ) : null}
          </div>
        )
      ) : null}

      {row.note ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-bold">{t('orders.noteLabel')}: </span>
          <bdi>{row.note}</bdi>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onHistory}>
          {t('orders.history.open')}
        </Button>
        {/* Editing is offered even on a locked order: the customer's name and
            the note are still correctable, and the editor says which parts
            are fixed. */}
        {perms.mayEdit && !cancelled ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onEdit}>
            {t('orders.edit')}
          </Button>
        ) : null}
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onInvoice}>
          {t('sale.printInvoice')}
        </Button>

        {perms.mayExchange && !cancelled && row.stage === 'delivered' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onExchange}>
            {t('exchange.button')}
          </Button>
        ) : null}

        {/* Only before it leaves: after that the goods come back through
            returns, not by changing a status. */}
        {perms.mayCancel && !cancelled && row.stage === 'to_ship' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs text-red-700" onClick={onCancel}>
            {t('orders.cancel')}
          </Button>
        ) : null}

        {/* Owner only - the database refuses anyone else. For a payment
            recorded by mistake, which the ordinary editor cannot touch once
            the order is paid. */}
        {perms.isOwner && !cancelled && row.payment_status === 'paid' ? (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onReopen}>
            {t('orders.reopenPayment')}
          </Button>
        ) : null}

        {settleable ? (
          <Button className="ms-auto" disabled={busy} onClick={() => onSettle('mark_order_paid')}>
            {busy ? t('app.loading') : t('orders.markPaid')}
          </Button>
        ) : null}

        {courierDelivered ? (
          <Button
            variant="secondary"
            className={settleable ? undefined : 'ms-auto'}
            disabled={busy}
            onClick={() => onSettle('mark_courier_delivered')}
          >
            {busy ? t('app.loading') : t('orders.customerReceived')}
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
    </div>
  );
}

// --- Cancelling ------------------------------------------------------------------

/**
 * Cancels an order that has not left yet: its items go back on the shelf, and
 * a website order is cancelled in Shopify too, without emailing the customer.
 */
function CancelOrderDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderRow;
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
      return event.details?.source === 'shopify'
        ? t('orders.history.itemsEditedShopify')
        : t('orders.history.itemsEdited');
    case 'shopify_synced':
      if (event.details?.action === 'cancel') return t('orders.history.shopifyCancelled');
      if (event.details?.shipping_updated === false) {
        return event.details?.items_changed
          ? t('orders.history.shopifyItemsNotShipping')
          : t('orders.history.shopifyShippingRefused');
      }
      return t('orders.history.shopifySynced');
    case 'shopify_refund':
      return t('orders.history.shopifyRefund', { amount: String(event.details?.amount_egp ?? '') });
    case 'payment_corrected':
      return t('orders.history.paymentCorrected');
    case 'exchange':
      return t('orders.history.exchange', { orderNumber: String(event.details?.replacement_order_number ?? '') });
    case 'exchange_refunded':
      return t('orders.history.exchangeRefunded', { amount: String(event.details?.amount_egp ?? '') });
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
