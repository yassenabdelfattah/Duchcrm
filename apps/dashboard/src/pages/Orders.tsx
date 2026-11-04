import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { can, canAny, formatEGP } from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { useSearchParams } from 'react-router';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { Button, Code, EmptyState, ErrorNote, Input, ListSkeleton, cx } from '../components/ui';
import { Invoice } from '../components/Invoice';
import { OrderEditor } from '../components/OrderEditor';
import { ExchangeDialog } from '../components/ExchangeDialog';
import { CancelOrderDialog } from '../components/CancelOrderDialog';
import { PartialDeliveryDialog } from '../components/PartialDeliveryDialog';
import {
  NO_FILTERS,
  PAGE_SIZE,
  SORTS,
  STORAGE_KEY,
  TABS,
  applyFilters,
  applySort,
  applyTab,
  nextStep,
  payable,
  readSavedView,
  stepsFor,
  type BulkAction,
  type Filters,
  type OrderRow,
  type Permissions,
  type Query,
  type SettleAction,
  type SortKey,
  type TabKey,
} from './orders/model';
import { OrderLine } from './orders/OrderLine';
import { OrderDetails } from './orders/OrderDetails';
import { OrderHistory } from './orders/OrderHistory';
import { BulkDialog } from './orders/BulkDialog';
import { FilterSheet, activeFilterChips, presetChips } from './orders/FilterSheet';
import { ReopenPaymentDialog, UndoDeliveredDialog } from './orders/dialogs';

/**
 * Every order, findable, and each one a line until it is needed.
 *
 * The owner's asks: an order shows all of itself - customer, address, the
 * shipment number, what they took, shipping, the note, where it is and for
 * how long (2026-10-04) - and the list is organised the way Shopify's is
 * (2026-10-23): one line per order with its next step as a button, tap to
 * open the rest; tick several and settle them together; lists with counts,
 * filters added as chips, and finished orders moved to an archive by
 * themselves. On a wide screen an opened order sits in a drawer beside the
 * list, so working down a list never loses the place (2026-11-04).
 *
 * It reads v_order_list, which flattens all of that into one row per order
 * and says whether anything is left to do on it (is_closed). The row types,
 * query builders and step rules live in ./orders/model.ts; the pieces of
 * the screen in ./orders/.
 */

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
    mayReturn: can(identity?.permissions, 'returns.manage'),
    isOwner: Boolean(identity?.is_owner),
  };
  const maySelect = perms.maySettle || perms.mayDeliver;
  // Wide enough for the drawer: an opened order beside the list, not inside it.
  const wide = useMediaQuery('(min-width: 1024px)');

  const [params] = useSearchParams();
  // A link from the home screen names the list to open (?tab=owed); without
  // one, the list, filters and order this browser used last.
  const initial = useMemo(() => {
    const saved = readSavedView();
    const linked = params.get('tab') as TabKey | null;
    if (params.get('q')) return { ...saved, filters: NO_FILTERS };
    return linked && TABS.includes(linked) ? { ...saved, tab: linked, filters: NO_FILTERS } : saved;
    // Read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [tab, setTab] = useState<TabKey>(initial.tab);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [sort, setSort] = useState<SortKey>(initial.sort);
  // A link to one order (?q=#1413, from a statement) searches for it and
  // opens it.
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const openLinked = useRef(Boolean(params.get('q')));
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
  const [undoing, setUndoing] = useState<OrderRow | null>(null);
  const [partial, setPartial] = useState<OrderRow | null>(null);
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
    const [only] = list;
    if (openLinked.current && only && list.length === 1) setExpanded(only.id);
    openLinked.current = false;
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
      applyTab(supabase.from('v_order_list').select('total_egp, shipping_egp, returned_off_egp'), 'owed').limit(2000),
    ]).then((results) => {
      if (cancelled) return;
      const owed = results.pop() as {
        data: Array<{ total_egp: number; shipping_egp: number; returned_off_egp: number }> | null;
      };
      setCounts(Object.fromEntries(results as Array<readonly [TabKey, number]>));
      setOwedTotal(
        (owed.data ?? []).reduce((sum, row) => sum + payable(row), 0),
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
  const presets = presetChips(filters, t);

  // On a wide screen the opened order lives in the drawer, not in the list.
  const drawerRow = wide && expanded ? (rows ?? []).find((row) => row.id === expanded) ?? null : null;

  const detailsFor = (row: OrderRow) => (
    <OrderDetails
      row={row}
      busy={busyId === row.id}
      perms={perms}
      onHistory={() => setHistory(row)}
      onEdit={() => setEditing(row)}
      onInvoice={() => setInvoiceId(row.id)}
      onSettle={(rpc) => void settle(row, rpc)}
      onReopen={() => setReopening(row)}
      onUndoDelivered={() => setUndoing(row)}
      onPartial={() => {
        setNotice(null);
        setPartial(row);
      }}
      onCancel={() => setCancelling(row)}
      onExchange={() => {
        setNotice(null);
        setExchanging(row);
      }}
    />
  );

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

        {/* What is narrowing the list (filled, removable), then the filters
            people reach for every day, one tap each (outlined). */}
        <div className="flex flex-wrap items-center gap-1.5">
          {activeFilters.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilters((f) => ({ ...f, ...chip.clear }))}
              className="flex min-h-8 items-center gap-1 rounded-full bg-duch-ink px-3 text-xs font-semibold text-white hover:bg-black"
            >
              {chip.label}
              <X className="size-3.5" aria-label={t('orders.filter.remove')} />
            </button>
          ))}
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => setFilters((f) => ({ ...f, ...preset.set }))}
              className="min-h-8 rounded-full border border-duch-line bg-white px-3 text-xs font-semibold text-stone-600 hover:border-stone-400 hover:text-duch-ink"
            >
              {preset.label}
            </button>
          ))}
          {activeFilters.length > 0 ? (
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="min-h-8 px-2 text-xs font-semibold text-stone-500 underline"
            >
              {t('orders.filter.clear')}
            </button>
          ) : null}
        </div>
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
            ship_name: editing.customer_name,
            ship_phone: editing.customer_phone,
            shopify_order_id: editing.shopify_order_id,
          }}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}

      {partial ? (
        <PartialDeliveryDialog
          order={partial}
          onClose={() => setPartial(null)}
          onDone={({ kept, back }) => {
            setNotice(t('orders.partialDone', { orderNumber: partial.order_number, kept, back }));
            setPartial(null);
            reload();
          }}
        />
      ) : null}

      {undoing ? (
        <UndoDeliveredDialog
          order={undoing}
          onClose={() => setUndoing(null)}
          onDone={() => {
            setUndoing(null);
            reload();
          }}
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
        <ListSkeleton label={t('app.loading')} />
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
                  {/* On a phone the order opens under its line; on a wide
                      screen it opens in the drawer instead. */}
                  {!wide ? detailsFor(row) : undefined}
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

      {/* A wide screen's opened order: beside the list, so working down a
          list never loses the place. Clicking another line swaps it. */}
      {drawerRow ? (
        <aside
          aria-label={drawerRow.order_number}
          className="animate-rise-in fixed inset-y-0 end-0 z-40 flex w-full max-w-md flex-col border-s border-duch-line bg-white shadow-2xl"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-duch-line px-4 py-3">
            <Code className="text-base font-extrabold">{drawerRow.order_number}</Code>
            <button
              type="button"
              onClick={() => setExpanded(null)}
              aria-label={t('app.close')}
              className="rounded-full p-2 text-stone-500 hover:bg-stone-100"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto overscroll-contain p-4">{detailsFor(drawerRow)}</div>
        </aside>
      ) : null}

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
