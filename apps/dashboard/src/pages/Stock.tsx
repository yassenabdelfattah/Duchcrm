import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { useSearchParams } from 'react-router';
import { can, formatEGP, type StockMovementReason } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { useLocale } from '../i18n';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import type { StaffIdentity } from '../providers/authProvider';
import { StockOutDialog, StockOutList, type PickRow } from '../components/StockOut';
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
  cx,
} from '../components/ui';

/**
 * Products and stock, one page.
 *
 * The owner's ask (2026-10-05): the products page and the stock page were the
 * same catalogue seen twice, so they are one. Each product appears once with
 * its photo, type, price and its sizes as chips carrying their stock; tapping
 * a product opens its details. Sizes can be picked across products and
 * changed together: goods received, a stock count, or taken out.
 *
 * Names, prices and photos come from Shopify and stay read-only here - an
 * import would overwrite any change made in the CRM. Stock is the CRM's.
 */

interface VariantRow {
  variant_id: string;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  price_egp: number;
  product_id: string;
  product_title: string;
  product_title_ar: string | null;
  product_status: string;
  image_url: string | null;
  location_id: string;
  quantity: number;
  is_low_stock: boolean;
  is_out_of_stock: boolean;
  is_unlinked: boolean;
}

interface ProductMeta {
  id: string;
  product_type: string | null;
}

interface ProductGroup {
  id: string;
  title: string;
  image_url: string | null;
  status: string;
  type: string | null;
  unlinked: boolean;
  variants: VariantRow[];
  total: number;
}

/** 'attention' is low or sold out together - what the home screen's card counts. */
type StockState = '' | 'out' | 'low' | 'in' | 'attention';
type BulkMode = 'receive' | 'count';

function variantLabel(row: { size: string | null; color: string | null }): string {
  return [row.size, row.color].filter(Boolean).join(' / ');
}

function stateOf(row: VariantRow): 'out' | 'low' | 'in' {
  return row.is_out_of_stock ? 'out' : row.is_low_stock ? 'low' : 'in';
}

export function Stock() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayAdjust = can(identity?.permissions, 'stock.adjust');
  const mayImport = can(identity?.permissions, 'products.manage');

  // A link from the home screen can open the stock-out tab (?tab=out) or a
  // stock filter (?state=low).
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'products' | 'out'>(() => (params.get('tab') === 'out' ? 'out' : 'products'));
  const [rows, setRows] = useState<VariantRow[] | null>(null);
  const [meta, setMeta] = useState<Map<string, ProductMeta>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [openOuts, setOpenOuts] = useState(0);

  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [stockState, setStockState] = useState<StockState>(() => {
    const linked = params.get('state');
    return linked === 'out' || linked === 'low' || linked === 'in' || linked === 'attention' ? linked : '';
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [adjusting, setAdjusting] = useState<VariantRow | null>(null);
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  const [takingOut, setTakingOut] = useState<PickRow[] | null>(null);
  const [importing, setImporting] = useState(false);

  const reload = () => setReloadToken((token) => token + 1);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // One shop: the default location's numbers are the stock.
      const { data: location } = await supabase
        .from('locations')
        .select('id')
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .limit(1)
        .maybeSingle();

      const [stockResult, productResult, outResult] = await Promise.all([
        supabase
          .from('v_stock_overview')
          .select(
            'variant_id, sku, barcode, size, color, price_egp, product_id, product_title, product_title_ar, product_status, image_url, location_id, quantity, is_low_stock, is_out_of_stock, is_unlinked',
          )
          .eq('is_active', true)
          .eq('location_id', (location?.id as string | undefined) ?? '00000000-0000-0000-0000-000000000000')
          .order('product_title')
          .order('sku')
          .limit(5000),
        supabase.from('products').select('id, product_type').limit(2000),
        supabase.from('v_stock_outs').select('id', { count: 'exact', head: true }).in('status', ['out', 'overdue']),
      ]);

      if (cancelled) return;
      if (stockResult.error) {
        setError(arabicError(stockResult.error));
        return;
      }
      setError(null);
      setRows((stockResult.data ?? []) as VariantRow[]);
      setMeta(new Map(((productResult.data ?? []) as ProductMeta[]).map((p) => [p.id, p])));
      setOpenOuts(outResult.count ?? 0);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // A scan anywhere on the page finds that item, without tapping the box.
  useBarcodeScanner(
    (code) => {
      setTab('products');
      setSearch(code);
    },
    { enabled: !adjusting && !bulk && !takingOut },
  );

  const groups = useMemo<ProductGroup[]>(() => {
    const byProduct = new Map<string, ProductGroup>();
    for (const row of rows ?? []) {
      let group = byProduct.get(row.product_id);
      if (!group) {
        group = {
          id: row.product_id,
          title: locale === 'ar' && row.product_title_ar ? row.product_title_ar : row.product_title,
          image_url: row.image_url,
          status: row.product_status,
          type: meta.get(row.product_id)?.product_type ?? null,
          unlinked: false,
          variants: [],
          total: 0,
        };
        byProduct.set(row.product_id, group);
      }
      group.variants.push(row);
      group.total += Number(row.quantity);
      group.unlinked ||= row.is_unlinked;
    }
    return [...byProduct.values()];
  }, [rows, meta, locale]);

  const types = useMemo(
    () => [...new Set(groups.map((g) => g.type).filter((x): x is string => Boolean(x)))].sort(),
    [groups],
  );

  const term = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups.filter((group) => {
        if (type && group.type !== type) return false;
        if (
          stockState &&
          !group.variants.some((v) =>
            stockState === 'attention' ? stateOf(v) !== 'in' : stateOf(v) === stockState,
          )
        )
          return false;
        if (!term) return true;
        return (
          group.title.toLowerCase().includes(term) ||
          group.variants.some(
            (v) =>
              v.sku.toLowerCase().includes(term) ||
              (v.barcode ?? '').toLowerCase() === term ||
              v.product_title.toLowerCase().includes(term),
          )
        );
      }),
    [groups, type, stockState, term],
  );

  // A search that names one item exactly - a scan, or a full SKU - opens its
  // product so the size is right there.
  useEffect(() => {
    if (!term) return;
    const exact = groups.find((g) =>
      g.variants.some((v) => v.sku.toLowerCase() === term || (v.barcode ?? '').toLowerCase() === term),
    );
    if (exact) setExpanded((current) => new Set(current).add(exact.id));
  }, [term, groups]);

  const selectedRows = useMemo(
    () => (rows ?? []).filter((row) => selected.has(row.variant_id)),
    [rows, selected],
  );

  function toggleVariant(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleProduct(group: ProductGroup) {
    setSelected((current) => {
      const next = new Set(current);
      const all = group.variants.every((v) => next.has(v.variant_id));
      for (const v of group.variants) {
        if (all) next.delete(v.variant_id);
        else next.add(v.variant_id);
      }
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importFromShopify() {
    setImporting(true);
    setError(null);
    setMessage(null);

    const { data, error: invokeError } = await supabase.functions.invoke<{
      summary?: { products_written: number; variants_written: number };
    }>('shopify-import-products', { body: {} });

    setImporting(false);

    if (invokeError) {
      // supabase-js only says "non-2xx status code". The function's own
      // answer - which SKU, and why - is in the response body.
      let detail = invokeError.message;
      const context = (invokeError as { context?: Response }).context;
      if (context) {
        try {
          const body = (await context.json()) as { error?: string; sku?: string; detail?: string };
          detail = [body.error, body.sku, body.detail].filter(Boolean).join(' · ') || detail;
        } catch {
          // Not JSON - keep the generic message.
        }
      }
      setError(arabicError(detail));
      return;
    }

    setMessage(
      t('products.imported', {
        products: data?.summary?.products_written ?? 0,
        variants: data?.summary?.variants_written ?? 0,
      }),
    );
    reload();
  }

  const chipTone: Record<'out' | 'low' | 'in', string> = {
    out: 'border-red-200 bg-red-50 text-red-700',
    low: 'border-amber-200 bg-amber-50 text-amber-800',
    in: 'border-duch-line bg-white text-duch-ink',
  };

  return (
    <div className={cx('space-y-4', selected.size > 0 && 'pb-24')}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">{t('inventory.title')}</h1>
        <div className="ms-auto flex flex-wrap gap-2">
          {mayAdjust ? (
            <Button variant="secondary" onClick={() => setTakingOut([])}>
              {t('stockOut.title')}
            </Button>
          ) : null}
          {mayImport ? (
            <Button variant="secondary" onClick={importFromShopify} disabled={importing}>
              {importing ? t('products.importing') : t('products.import')}
            </Button>
          ) : null}
        </div>
      </div>

      {message ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">{message}</p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="flex gap-1.5">
        {(['products', 'out'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cx(
              'flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-bold',
              tab === key ? 'bg-duch-ink text-white' : 'text-stone-600 hover:bg-stone-100',
            )}
          >
            {t(`inventory.tab.${key}`)}
            {key === 'out' && openOuts > 0 ? (
              <span className="tabular rounded-md bg-duch-accent px-1.5 text-xs text-white">{openOuts}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'out' ? <StockOutList mayAdjust={mayAdjust} reloadToken={reloadToken} /> : null}

      {tab === 'products' ? (
        <>
          <div className="space-y-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('inventory.searchPlaceholder')}
              autoComplete="off"
              inputMode="search"
            />
            <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
                className={cx(
                  'min-h-9 shrink-0 rounded-lg border px-2.5 text-sm font-semibold',
                  type ? 'border-duch-ink bg-duch-ink text-white' : 'border-duch-line bg-white text-stone-700',
                )}
              >
                <option value="">{t('inventory.allTypes')}</option>
                {types.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              {/* The combined filter only shows while it is on, so it can be seen and cleared. */}
              {(['', 'out', 'low', 'in', ...(stockState === 'attention' ? ['attention'] : [])] as StockState[]).map((value) => (
                <button
                  key={value || 'all'}
                  type="button"
                  onClick={() => setStockState(value)}
                  className={cx(
                    'min-h-9 shrink-0 rounded-lg border px-3 text-sm font-semibold',
                    stockState === value
                      ? 'border-duch-ink bg-duch-ink text-white'
                      : 'border-duch-line bg-white text-stone-700',
                  )}
                >
                  {t(`inventory.state.${value || 'all'}`)}
                </button>
              ))}
            </div>
          </div>

          {!rows ? (
            <Spinner label={t('app.loading')} />
          ) : visible.length === 0 ? (
            <EmptyState title={t('stock.empty')} />
          ) : (
            <div className="space-y-2">
              {visible.map((group) => {
                const isOpen = expanded.has(group.id);
                const allPicked = group.variants.every((v) => selected.has(v.variant_id));
                return (
                  <Card key={group.id} className="space-y-3 p-3 sm:p-4">
                    <div className="flex items-start gap-3">
                      {mayAdjust ? (
                        <input
                          type="checkbox"
                          aria-label={t('inventory.selectAllSizes')}
                          checked={allPicked}
                          onChange={() => toggleProduct(group)}
                          className="mt-1 size-4 shrink-0 accent-duch-ink"
                        />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => toggleExpanded(group.id)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-start"
                      >
                        {group.image_url ? (
                          <img
                            src={group.image_url}
                            alt=""
                            loading="lazy"
                            className="size-14 shrink-0 rounded-lg object-cover"
                          />
                        ) : (
                          <span className="size-14 shrink-0 rounded-lg bg-stone-100" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block font-bold">
                            <bdi>{group.title}</bdi>
                          </span>
                          <span className="block text-xs text-stone-500">
                            {[group.type, formatEGP(Number(group.variants[0]?.price_egp ?? 0), locale)]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            {group.status !== 'active' ? (
                              <Badge>{t(`inventory.productStatus.${group.status}`)}</Badge>
                            ) : null}
                            {group.unlinked ? <Badge tone="warn">{t('stock.notSynced')}</Badge> : null}
                          </span>
                        </span>
                        <span className="text-end">
                          <span className="tabular block text-lg font-extrabold">{group.total}</span>
                          <span className="block text-xs text-stone-500">{t('inventory.pieces')}</span>
                        </span>
                      </button>
                    </div>

                    {/* Each size with its stock. Tapping one picks it for a
                        change across several sizes. */}
                    <div className="flex flex-wrap gap-1.5">
                      {group.variants.map((v) => {
                        const picked = selected.has(v.variant_id);
                        return (
                          <button
                            key={v.variant_id}
                            type="button"
                            disabled={!mayAdjust}
                            onClick={() => toggleVariant(v.variant_id)}
                            title={v.sku}
                            className={cx(
                              'min-w-14 rounded-lg border px-2 py-1 text-center leading-tight disabled:cursor-default',
                              picked ? 'border-duch-ink bg-duch-ink text-white' : chipTone[stateOf(v)],
                              term && v.sku.toLowerCase().includes(term) && !picked && 'ring-2 ring-duch-accent',
                            )}
                          >
                            <span className="block text-xs font-bold">{variantLabel(v) || v.sku}</span>
                            <span className="tabular block text-sm font-extrabold">{v.quantity}</span>
                          </button>
                        );
                      })}
                    </div>

                    {isOpen ? (
                      <div className="overflow-x-auto rounded-lg border border-duch-line">
                        <table className="w-full min-w-[34rem] text-sm">
                          <thead className="bg-stone-50 text-xs text-stone-500">
                            <tr>
                              <th className="px-3 py-2 text-start font-semibold">{t('stock.variant')}</th>
                              <th className="px-3 py-2 text-start font-semibold">{t('stock.sku')}</th>
                              <th className="px-3 py-2 text-start font-semibold">{t('inventory.barcode')}</th>
                              <th className="px-3 py-2 text-end font-semibold">{t('sale.unitPrice')}</th>
                              <th className="px-3 py-2 text-end font-semibold">{t('stock.quantity')}</th>
                              {mayAdjust ? <th className="px-3 py-2" /> : null}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-duch-line">
                            {group.variants.map((v) => (
                              <tr key={v.variant_id}>
                                <td className="px-3 py-2">{variantLabel(v) || '—'}</td>
                                <td className="px-3 py-2">
                                  <Code>{v.sku}</Code>
                                </td>
                                <td className="px-3 py-2 text-stone-600">
                                  {v.barcode ? <Code>{v.barcode}</Code> : '—'}
                                </td>
                                <td className="tabular px-3 py-2 text-end">{formatEGP(Number(v.price_egp), locale)}</td>
                                <td className="tabular px-3 py-2 text-end font-bold">{v.quantity}</td>
                                {mayAdjust ? (
                                  <td className="px-3 py-2 text-end">
                                    <Button
                                      variant="secondary"
                                      className="min-h-8 px-2.5 text-xs"
                                      onClick={() => setAdjusting(v)}
                                    >
                                      {t('stock.adjust')}
                                    </Button>
                                  </td>
                                ) : null}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {/* What to do with the sizes picked, across any number of products. */}
      {selected.size > 0 && tab === 'products' ? (
        <div className="fixed inset-x-0 bottom-16 z-40 px-4 sm:bottom-4">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-xl bg-duch-ink p-3 text-white shadow-xl">
            <span className="text-sm font-bold">{t('inventory.selected', { count: selected.size })}</span>
            <div className="ms-auto flex flex-wrap gap-2">
              <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => setBulk('receive')}>
                {t('inventory.receive')}
              </Button>
              <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => setBulk('count')}>
                {t('inventory.count')}
              </Button>
              <Button
                variant="secondary"
                className="min-h-9 px-3 text-xs"
                onClick={() =>
                  setTakingOut(
                    selectedRows.map((row) => ({
                      variant_id: row.variant_id,
                      sku: row.sku,
                      size: row.size,
                      color: row.color,
                      product_title: row.product_title_ar ?? row.product_title,
                      quantity: row.quantity,
                    })),
                  )
                }
              >
                {t('stockOut.title')}
              </Button>
              <Button
                variant="ghost"
                className="min-h-9 px-3 text-xs text-white hover:bg-white/10"
                onClick={() => setSelected(new Set())}
              >
                {t('inventory.clearSelection')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {adjusting ? (
        <AdjustDialog
          row={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null);
            reload();
          }}
        />
      ) : null}

      {bulk ? (
        <BulkDialog
          mode={bulk}
          rows={selectedRows}
          onClose={() => setBulk(null)}
          onDone={(changed) => {
            setBulk(null);
            setSelected(new Set());
            setMessage(t('inventory.saved', { count: changed }));
            reload();
          }}
        />
      ) : null}

      {takingOut ? (
        <StockOutDialog
          initial={takingOut}
          onClose={() => setTakingOut(null)}
          onDone={() => {
            setTakingOut(null);
            setSelected(new Set());
            setTab('out');
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

// --- Several sizes at once ---------------------------------------------------------

function BulkDialog({
  mode,
  rows,
  onClose,
  onDone,
}: {
  mode: BulkMode;
  rows: VariantRow[];
  onClose: () => void;
  onDone: (changed: number) => void;
}) {
  const { t } = useLocale();
  // Received starts empty; a count starts at what the system says, so only
  // the sizes that differ need touching.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.variant_id, mode === 'count' ? String(row.quantity) : ''])),
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per window, so a second tap never records the goods twice.
  const idempotencyKey = useRef(`bulk-${mode}-${crypto.randomUUID()}`);

  const parsed = rows.map((row) => {
    const raw = values[row.variant_id]?.trim() ?? '';
    const value = raw === '' ? null : Number(raw);
    return { row, value };
  });
  const invalid = parsed.some(({ value }) => value !== null && (!Number.isInteger(value) || value < 0));

  const pushFast = useCallback((variantIds: string[], locationId: string | undefined) => {
    // Fast path to Shopify; the outbox covers it if this call does not land.
    void supabase.functions
      .invoke('push-inventory', { body: { variant_ids: variantIds, location_id: locationId } })
      .catch(() => undefined);
  }, []);

  async function submit() {
    if (invalid) {
      setError(t('inventory.wholeNumbers'));
      return;
    }
    const locationId = rows[0]?.location_id;
    setBusy(true);
    setError(null);

    if (mode === 'receive') {
      const movements = parsed
        .filter(({ value }) => value !== null && value > 0)
        .map(({ row, value }) => ({ variant_id: row.variant_id, quantity_delta: value as number }));
      if (movements.length === 0) {
        setBusy(false);
        setError(t('inventory.enterSomething'));
        return;
      }
      const { error: rpcError } = await supabase.rpc('record_stock_movements', {
        p_location_id: locationId,
        p_reason: 'production_in',
        p_movements: movements,
        p_reference_type: 'bulk_receive',
        p_reference_id: null,
        p_note: note.trim() || null,
        p_idempotency_key: idempotencyKey.current,
      });
      setBusy(false);
      if (rpcError) {
        setError(arabicError(rpcError));
        return;
      }
      pushFast(
        movements.map((m) => m.variant_id),
        locationId,
      );
      onDone(movements.length);
      return;
    }

    const counts = parsed
      .filter(({ value }) => value !== null)
      .map(({ row, value }) => ({ variant_id: row.variant_id, counted: value }));
    const { data, error: rpcError } = await supabase.rpc('record_stock_count', {
      p_location_id: locationId,
      p_counts: counts,
      p_note: note.trim() || t('inventory.countNote'),
      p_idempotency_key: idempotencyKey.current,
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    pushFast(
      counts.map((c) => c.variant_id),
      locationId,
    );
    onDone(Number((data as { changed?: number } | null)?.changed ?? 0));
  }

  return (
    <Modal open title={mode === 'receive' ? t('inventory.receive') : t('inventory.count')} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
          {mode === 'receive' ? t('inventory.receiveHelp') : t('inventory.countHelp')}
        </p>

        <ul className="divide-y divide-duch-line rounded-lg border border-duch-line text-sm">
          {parsed.map(({ row, value }) => {
            const after = value === null ? row.quantity : mode === 'receive' ? row.quantity + value : value;
            return (
              <li key={row.variant_id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    <bdi>{row.product_title_ar ?? row.product_title}</bdi>
                  </span>
                  <span className="block text-xs text-stone-500">
                    {variantLabel(row) ? `${variantLabel(row)} · ` : ''}
                    <Code>{row.sku}</Code> · {t('inventory.now', { count: row.quantity })}
                    {value !== null && Number.isInteger(after) && after !== row.quantity ? (
                      <span className="font-bold text-duch-ink"> → {after}</span>
                    ) : null}
                  </span>
                </span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={values[row.variant_id] ?? ''}
                  placeholder={mode === 'receive' ? '0' : String(row.quantity)}
                  onChange={(event) => setValues((current) => ({ ...current, [row.variant_id]: event.target.value }))}
                  className="tabular w-20 text-center"
                />
              </li>
            );
          })}
        </ul>

        <Field label={t('queue.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy || invalid}>
            {busy ? t('app.loading') : t('app.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- One size, by hand -------------------------------------------------------------

/** Reasons a person can pick when adjusting by hand. The rest are machine-written. */
const MANUAL_REASONS: StockMovementReason[] = ['adjustment', 'production_in', 'return'];

function AdjustDialog({ row, onClose, onDone }: { row: VariantRow; onClose: () => void; onDone: () => void }) {
  const { t } = useLocale();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<StockMovementReason>('adjustment');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const amount = Number(delta);
    if (!Number.isInteger(amount) || amount === 0) {
      setError(t('stock.adjustAmount'));
      return;
    }

    setSaving(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('record_stock_movements', {
      p_location_id: row.location_id,
      p_reason: reason,
      p_movements: [{ variant_id: row.variant_id, quantity_delta: amount }],
      p_reference_type: 'manual_adjustment',
      p_reference_id: null,
      p_note: note || null,
    });

    setSaving(false);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }

    // Fast path to Shopify; the outbox covers it if this call does not land.
    void supabase.functions
      .invoke('push-inventory', { body: { variant_ids: [row.variant_id], location_id: row.location_id } })
      .catch(() => undefined);

    onDone();
  }

  return (
    <Modal open title={t('stock.adjustTitle', { sku: row.sku })} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">{t('stock.adjustHelp')}</p>

        <Field label={t('stock.adjustAmount')}>
          <Input
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            inputMode="numeric"
            placeholder="-1"
            className="tabular"
            dir="ltr"
          />
        </Field>

        <Field label={t('stock.adjustReason')}>
          <Select value={reason} onChange={(event) => setReason(event.target.value as StockMovementReason)}>
            {MANUAL_REASONS.map((value) => (
              <option key={value} value={value}>
                {t(`reason.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('stock.adjustNote')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={saving}>
            {saving ? t('app.loading') : t('app.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
