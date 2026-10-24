import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Pencil } from 'lucide-react';
import { can, formatDate, formatEGP } from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Spinner,
  cx,
} from '../components/ui';
import {
  AccountantSummary,
  type Breakdown,
  type ProductRow,
  type StatementLine,
} from '../components/AccountantSummary';

interface ParcelPreview {
  found: boolean;
  tracking_number: string;
  order_number?: string;
  customer_name?: string | null;
  goods_egp?: number;
  expected_egp?: number;
  already_on?: string | null;
  fulfillment_status?: string;
  /** Paid before it left: the courier had nothing to collect. */
  prepaid?: boolean;
  items?: Array<{
    sku: string;
    title: string;
    variant_title: string | null;
    quantity: number;
    unit_price_egp: number;
    total_egp: number;
  }>;
}

/**
 * The outcomes a line on their statement can be, delivered first because that
 * is most of them and it is the default.
 */
const ALL_OUTCOMES = [
  'delivered',
  'returned_refused',
  'returned_no_response',
  'returned_other',
  'adjustment',
] as const;

interface SettlementRow {
  id: string;
  reference: string | null;
  statement_date: string | null;
  received_at: string | null;
  net_received_egp: number | null;
  status: 'draft' | 'reviewed' | 'exported';
  note: string | null;
  line_count: number;
  collected_egp: number;
  fees_egp: number;
  net_egp: number;
  difference_egp: number;
  unmatched_lines: number;
}

/** An order found by the search on a statement, before it is chosen. */
interface SearchHit {
  id: string;
  order_number: string;
  tracking_number: string;
  customer_name: string | null;
  fulfillment_status: string;
}

/** The parcels on a statement - any statement - that need a second look. */
interface CheckRow {
  settlement_id: string;
  reference: string | null;
  line_id: string;
  order_number: string;
  customer_name: string | null;
  mismatch: NonNullable<StatementLine['mismatch']>;
}

/** Straight to the order on the Orders screen, opened. */
function OrderLink({ orderNumber }: { orderNumber: string }) {
  return (
    <Link
      to={`/orders?q=${encodeURIComponent(orderNumber)}`}
      className="tabular font-semibold text-duch-ink underline decoration-stone-300 underline-offset-2 hover:decoration-duch-ink"
      dir="ltr"
    >
      {orderNumber}
    </Link>
  );
}

interface AwaitingRow {
  order_id: string;
  order_number: string;
  tracking_number: string | null;
  cod_amount_egp: number | null;
  days_waiting: number;
  customer_name: string | null;
  fulfillment_status: string;
}

export function Settlements() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayManage = can(identity?.permissions, 'settlements.manage');

  const [list, setList] = useState<SettlementRow[] | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingRow[] | null>(null);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const [settlements, pending, mismatches] = await Promise.all([
      supabase.from('v_settlements').select('*').order('received_at', { ascending: false, nullsFirst: false }).limit(100),
      supabase.from('v_awaiting_settlement').select('*').order('days_waiting', { ascending: false }).limit(100),
      // Closed statements too: a parcel Accurate says came back is still
      // missing from the shelf until someone checks it in.
      supabase
        .from('v_settlement_statement')
        .select('settlement_id, reference, line_id, order_number, customer_name, mismatch')
        .not('mismatch', 'is', null)
        .order('received_at', { ascending: false })
        .limit(100),
    ]);
    setList((settlements.data ?? []) as SettlementRow[]);
    setAwaiting((pending.data ?? []) as AwaitingRow[]);
    setChecks((mismatches.data ?? []) as CheckRow[]);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  if (!mayManage) {
    return <EmptyState title={t('auth.noAccess')} />;
  }

  if (openId) {
    return (
      <SettlementDetail
        settlementId={openId}
        onBack={() => {
          setOpenId(null);
          void loadList();
        }}
      />
    );
  }

  if (!list) return <Spinner label={t('app.loading')} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-extrabold">{t('settlements.title')}</h1>
        <Button className="ms-auto" onClick={() => setCreating(true)}>
          {t('settlements.new')}
        </Button>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {list.length === 0 ? (
        <EmptyState title={t('settlements.empty')} />
      ) : (
        <div className="space-y-3">
          {list.map((row) => (
            <Card key={row.id}>
              <button
                type="button"
                onClick={() => setOpenId(row.id)}
                className="flex w-full flex-wrap items-center gap-3 text-start"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular text-sm font-extrabold">
                      {row.reference ?? '—'}
                    </span>
                    <Badge tone={row.status === 'draft' ? 'warn' : 'good'}>
                      {t(`settlements.${row.status}`)}
                    </Badge>
                    {row.status === 'draft' && Math.abs(Number(row.difference_egp)) > 0.009 ? (
                      <Badge tone="bad">
                        {t('settlements.difference')} {formatEGP(Number(row.difference_egp), locale)}
                      </Badge>
                    ) : null}
                    {checks.some((check) => check.settlement_id === row.id) ? (
                      <Badge tone="warn">
                        {t('settlements.checksCount', {
                          count: checks.filter((check) => check.settlement_id === row.id).length,
                        })}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {row.received_at ? formatDate(row.received_at, locale) : '—'} ·{' '}
                    {t('settlements.lines', { count: row.line_count })}
                  </p>
                </div>
                <span className="tabular text-base font-extrabold">
                  {formatEGP(Number(row.net_egp), locale)}
                </span>
              </button>
            </Card>
          ))}
        </div>
      )}

      {/* What their paper says against what we know: a parcel they say came
          back that nobody has checked in is a piece missing from the shelf. */}
      {checks.length > 0 ? (
        <section className="space-y-2 pt-2">
          <h2 className="text-sm font-bold">{t('settlements.needsLook')}</h2>
          <p className="text-xs text-stone-500">{t('settlements.needsLookHelp')}</p>
          <Card className="divide-y divide-duch-line p-0">
            {checks.map((check) => (
              <div key={check.line_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                <OrderLink orderNumber={check.order_number} />
                <bdi className="text-xs text-stone-500">{check.customer_name ?? '—'}</bdi>
                <span className="min-w-0 flex-1 text-xs font-semibold text-amber-800">
                  {t(`settlementMismatch.${check.mismatch}`)}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenId(check.settlement_id)}
                  className="tabular text-xs text-stone-500 underline underline-offset-2"
                  dir="ltr"
                >
                  {check.reference ?? '—'}
                </button>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {/* Working only from their paper would never surface an order they
          delivered and quietly never paid for. This list is that check. */}
      <section className="space-y-2 pt-2">
        <h2 className="text-sm font-bold">{t('settlements.awaiting')}</h2>
        <p className="text-xs text-stone-500">{t('settlements.awaitingHelp')}</p>
        {!awaiting ? (
          <Spinner />
        ) : awaiting.length === 0 ? (
          <EmptyState title={t('settlements.awaitingEmpty')} />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[40rem] text-sm">
              <tbody className="divide-y divide-duch-line">
                {awaiting.map((row) => (
                  <tr key={row.order_id}>
                    <td className="px-4 py-2">
                      <OrderLink orderNumber={row.order_number} />
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <bdi>{row.customer_name ?? '—'}</bdi>
                    </td>
                    <td className="tabular px-4 py-2 text-xs text-stone-500" dir="ltr">
                      {row.tracking_number ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {t(`fulfillment.${row.fulfillment_status}`)}
                    </td>
                    <td className="tabular px-4 py-2 text-end">
                      {formatEGP(Number(row.cod_amount_egp ?? 0), locale)}
                    </td>
                    <td className="px-4 py-2 text-end">
                      <Badge tone={row.days_waiting > 14 ? 'bad' : 'neutral'}>
                        {t('settlements.daysWaiting', { count: Math.floor(row.days_waiting) })}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <NewSettlementDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setOpenId(id);
        }}
        onError={setError}
      />
    </div>
  );
}

// --- Starting a statement ---------------------------------------------------

function NewSettlementDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLocale();
  const today = new Date().toISOString().slice(0, 10);
  const [reference, setReference] = useState('');
  const [statementDate, setStatementDate] = useState(today);
  const [receivedAt, setReceivedAt] = useState(today);
  const [netReceived, setNetReceived] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReference('');
      setStatementDate(today);
      setReceivedAt(today);
      setNetReceived('');
    }
  }, [open, today]);

  if (!open) return null;

  async function create() {
    setBusy(true);
    const { data, error } = await supabase
      .from('courier_settlements')
      .insert({
        reference: reference || null,
        statement_date: statementDate || null,
        received_at: receivedAt || null,
        net_received_egp: netReceived === '' ? null : Number(netReceived),
      })
      .select('id')
      .single();

    setBusy(false);
    if (error) {
      onError(arabicError(error));
      return;
    }
    onCreated(data.id as string);
  }

  return (
    <Modal open title={t('settlements.newTitle')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('settlements.reference')} hint={t('settlements.referenceHelp')}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('settlements.statementDate')}>
            <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
          </Field>
          <Field label={t('settlements.receivedAt')}>
            <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </Field>
        </div>
        <Field label={t('settlements.netReceived')} hint={t('settlements.netReceivedHelp')}>
          <Input
            value={netReceived}
            onChange={(e) => setNetReceived(e.target.value)}
            inputMode="decimal"
            className="tabular"
            dir="ltr"
          />
        </Field>
        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={create} disabled={busy}>
            {t('settlements.create')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Working down their statement -------------------------------------------

function SettlementDetail({
  settlementId,
  onBack,
}: {
  settlementId: string;
  onBack: () => void;
}) {
  const { t, locale } = useLocale();

  const [header, setHeader] = useState<SettlementRow | null>(null);
  const [lines, setLines] = useState<StatementLine[] | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [preview, setPreview] = useState<ParcelPreview | null>(null);
  // The parcel chosen to go on the statement - its code - or '' for none yet.
  const [tracking, setTracking] = useState('');
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [showAdjustment, setShowAdjustment] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const [outcome, setOutcome] = useState<string>('delivered');
  const [collected, setCollected] = useState('');
  const [fee, setFee] = useState('');
  const [netReceived, setNetReceived] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [lineNote, setLineNote] = useState('');
  const [adjLabel, setAdjLabel] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [settlementNote, setSettlementNote] = useState('');
  const [openOrders, setOpenOrders] = useState<AwaitingRow[]>([]);
  const [editing, setEditing] = useState<StatementLine | null>(null);
  const [reopening, setReopening] = useState(false);

  const searchBox = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const [head, detail, productRows, breakdownRow, waiting] = await Promise.all([
      supabase.from('v_settlements').select('*').eq('id', settlementId).single(),
      supabase.from('v_settlement_statement').select('*').eq('settlement_id', settlementId),
      supabase
        .from('v_settlement_products')
        .select('*')
        .eq('settlement_id', settlementId)
        .order('total_egp', { ascending: false }),
      supabase
        .from('v_settlement_breakdown')
        .select('*')
        .eq('settlement_id', settlementId)
        .maybeSingle(),
      // Parcels delivered and not yet on any statement. Typing a tracking
      // code off their paper still works and is faster when you have the
      // paper in front of you; this is for the other half of the job, where
      // you are chasing what has not been paid for yet.
      supabase
        .from('v_awaiting_settlement')
        .select('order_id, order_number, tracking_number, cod_amount_egp, days_waiting, customer_name, fulfillment_status')
        .order('days_waiting', { ascending: false })
        .limit(100),
    ]);
    const row = head.data as SettlementRow | null;
    setHeader(row);
    setNetReceived(row?.net_received_egp == null ? '' : String(row.net_received_egp));
    setLines((detail.data ?? []) as StatementLine[]);
    setProducts((productRows.data ?? []) as ProductRow[]);
    setBreakdown((breakdownRow.data ?? null) as Breakdown | null);
    setOpenOrders((waiting.data ?? []) as AwaitingRow[]);
    setSettlementNote(row?.note ?? '');
  }, [settlementId]);

  /**
   * A charge that belongs to no parcel: packaging, a returns handling fee, a
   * correction for last month. Without these a statement cannot be made to
   * balance, and an unbalanced statement cannot be closed at all.
   */
  async function addAdjustment() {
    const amount = Number(adjAmount);
    if (!adjLabel.trim() || !Number.isFinite(amount) || amount === 0) {
      setError(t('settlements.adjustmentIncomplete'));
      return;
    }

    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('add_settlement_adjustment', {
      p_settlement_id: settlementId,
      p_label: adjLabel.trim(),
      p_amount_egp: amount,
    });
    setBusy(false);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    setAdjLabel('');
    setAdjAmount('');
    await load();
  }

  async function saveSettlementNote() {
    const { error: updateError } = await supabase
      .from('courier_settlements')
      .update({ note: settlementNote.trim() || null })
      .eq('id', settlementId);

    if (updateError) {
      setError(arabicError(updateError));
      return;
    }
    setToast(t('settlements.noteSaved'));
  }

  useEffect(() => {
    void load();
  }, [load]);

  // Found the way a product is: by any part of the shipment number, the order
  // number or the customer, from every order with a shipment number.
  useEffect(() => {
    const value = term.trim().replace(/[%,()*]/g, '');
    if (value.length < 2) {
      setHits([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      supabase
        .from('v_order_list')
        .select('id, order_number, tracking_number, customer_name, fulfillment_status')
        .not('tracking_number', 'is', null)
        .or(
          [
            `tracking_number.ilike.%${value}%`,
            `order_number.ilike.%${value}%`,
            `customer_name.ilike.%${value}%`,
            `customer_phone.ilike.%${value}%`,
          ].join(','),
        )
        .limit(8)
        .then(({ data }) => {
          if (!cancelled) setHits((data ?? []) as SearchHit[]);
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  // What is in the chosen parcel, to check against their paper before it goes
  // on. This is also where a parcel already on another statement says so.
  useEffect(() => {
    if (!tracking) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    supabase
      .rpc('lookup_shipment_for_settlement', { p_tracking: tracking })
      .then(({ data }) => {
        if (cancelled) return;
        const found = (data ?? null) as ParcelPreview | null;
        setPreview(found);
        // Back with us already: most likely a return on their paper too.
        if (found?.fulfillment_status === 'returned' || found?.fulfillment_status === 'return_in_transit') {
          setOutcome('returned_other');
        }
      });
    addButton.current?.focus();

    return () => {
      cancelled = true;
    };
  }, [tracking]);

  function choose(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setTracking(trimmed);
    setTerm('');
    setHits([]);
    setOutcome('delivered');
    setCollected('');
    setFee('');
    setLineNote('');
    setPreview(null);
  }

  function clearChoice() {
    setTracking('');
    setPreview(null);
    searchBox.current?.focus();
  }

  const addLine = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;

      setBusy(true);
      setError(null);

      const { error: rpcError } = await supabase.rpc('add_settlement_line', {
        p_settlement_id: settlementId,
        p_tracking_number: trimmed,
        p_outcome: outcome,
        // Blank means "use what the order says", which is the whole point of
        // keying only the code for a normal delivered line.
        p_collected_egp: collected === '' ? null : Number(collected),
        p_fee_egp: fee === '' ? 0 : Number(fee),
        p_note: lineNote.trim() || null,
      });

      setBusy(false);

      if (rpcError) {
        setError(arabicError(rpcError));
        return;
      }

      setTracking('');
      setCollected('');
      setFee('');
      setLineNote('');
      setPreview(null);
      searchBox.current?.focus();
      await load();
    },
    [collected, fee, lineNote, load, outcome, settlementId],
  );

  // A label scanned anywhere on the page chooses its parcel, to be checked and
  // then added - not added blind.
  useBarcodeScanner((scanned) => choose(scanned), {
    enabled: header?.status === 'draft' && !busy && !searchFocused,
  });

  async function saveNetReceived() {
    const { error: updateError } = await supabase
      .from('courier_settlements')
      .update({ net_received_egp: netReceived === '' ? null : Number(netReceived) })
      .eq('id', settlementId);
    if (updateError) setError(arabicError(updateError));
    else await load();
  }

  async function removeLine(lineId: string) {
    const { error: rpcError } = await supabase.rpc('remove_settlement_line', { p_line_id: lineId });
    if (rpcError) setError(arabicError(rpcError));
    else await load();
  }

  async function review() {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('review_settlement', {
      p_settlement_id: settlementId,
    });
    setBusy(false);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    const result = data as { orders_marked_paid: number };
    setToast(t('settlements.reviewed_toast', { count: result.orders_marked_paid }));
    await load();
  }

  async function reopen() {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('reopen_settlement', {
      p_settlement_id: settlementId,
    });
    setBusy(false);
    setReopening(false);

    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    setToast(t('settlements.reopened_toast'));
    await load();
  }

  if (!header || !lines) return <Spinner label={t('app.loading')} />;

  const isDraft = header.status === 'draft';
  const difference = Number(header.difference_egp);
  const balanced = Math.abs(difference) <= 0.009;

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onBack} className="text-sm">
          ←
        </Button>
        <h1 className="tabular text-lg font-extrabold">{header.reference ?? '—'}</h1>
        <Badge tone={isDraft ? 'warn' : 'good'}>{t(`settlements.${header.status}`)}</Badge>
        {!isDraft ? (
          <Button variant="secondary" className="ms-auto min-h-9 text-xs" onClick={() => setReopening(true)}>
            {t('settlements.reopen')}
          </Button>
        ) : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {toast ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          {toast}
        </p>
      ) : null}

      {isDraft ? (
        <Card className="no-print space-y-3">
          <h2 className="text-sm font-bold">{t('settlements.addLine')}</h2>

          {!tracking ? (
            <div className="relative">
              <Field label={t('settlements.searchLabel')} hint={t('settlements.searchHint')}>
                <Input
                  ref={searchBox}
                  autoFocus
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    // One match is the one; otherwise what was typed is taken as
                    // a full shipment number off their paper, known or not.
                    const [only] = hits;
                    if (only && hits.length === 1) choose(only.tracking_number);
                    else choose(term);
                  }}
                  autoComplete="off"
                />
              </Field>

              {/* Held open by onMouseDown, or the box loses focus and the list
                  closes before the click lands. */}
              {term.trim().length >= 2 || (searchFocused && openOrders.length > 0) ? (
                <ul
                  className="mt-1 max-h-80 divide-y divide-duch-line overflow-y-auto rounded-lg border border-duch-line bg-white"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {term.trim().length < 2 ? (
                    <>
                      {/* Nothing typed yet: what is still owed, oldest first. */}
                      <li className="bg-stone-50 px-3 py-1.5 text-xs font-bold text-stone-500">
                        {t('settlements.waitingSuggestions', { count: openOrders.length })}
                      </li>
                      {openOrders
                        .filter((row) => row.tracking_number)
                        .map((row) => (
                          <SearchResult
                            key={row.order_id}
                            orderNumber={row.order_number}
                            customer={row.customer_name}
                            tracking={row.tracking_number ?? ''}
                            detail={t('settlements.waitingDays', { count: Math.floor(row.days_waiting) })}
                            onChoose={choose}
                          />
                        ))}
                    </>
                  ) : hits.length > 0 ? (
                    hits.map((hit) => (
                      <SearchResult
                        key={hit.id}
                        orderNumber={hit.order_number}
                        customer={hit.customer_name}
                        tracking={hit.tracking_number}
                        detail={t(`fulfillment.${hit.fulfillment_status}`)}
                        onChoose={choose}
                      />
                    ))
                  ) : (
                    <li>
                      <button
                        type="button"
                        onClick={() => choose(term)}
                        className="w-full px-3 py-2 text-start text-sm text-stone-600 hover:bg-stone-50"
                      >
                        {t('settlements.useCode', { code: term.trim() })}
                      </button>
                    </li>
                  )}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {preview ? <ParcelCard preview={preview} /> : <Spinner label={t('app.loading')} />}
                </div>
                <Button
                  variant="ghost"
                  className="min-h-9 px-2 text-xs"
                  aria-label={t('settlements.clearChoice')}
                  onClick={clearChoice}
                >
                  ✕
                </Button>
              </div>

              {/* Delivered first and selected by default, because most lines
                  on their statement are deliveries and the fastest path
                  through a page of them is to only touch what differs. */}
              <div className="flex flex-wrap gap-2">
                {ALL_OUTCOMES.filter((value) => value !== 'adjustment').map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setOutcome(value)}
                    className={cx(
                      'min-h-11 rounded-lg border px-3 text-xs font-semibold transition-colors',
                      outcome === value
                        ? 'border-duch-ink bg-duch-ink text-white'
                        : 'border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                    )}
                  >
                    {t(`settlementOutcome.${value}`)}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t('settlements.collected')}>
                  <Input
                    value={collected}
                    onChange={(e) => setCollected(e.target.value)}
                    inputMode="decimal"
                    className="tabular"
                    dir="ltr"
                    placeholder="auto"
                  />
                </Field>
                <Field label={t('settlements.fee')}>
                  <Input
                    value={fee}
                    onChange={(e) => setFee(e.target.value)}
                    inputMode="decimal"
                    className="tabular"
                    dir="ltr"
                    placeholder="0"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addLine(tracking);
                    }}
                  />
                </Field>
              </div>

              {/* Why this line is not what was expected. The place to write
                  "they charged us twice" while it is still in front of you. */}
              <Field label={t('settlements.lineNote')}>
                <Input
                  value={lineNote}
                  onChange={(e) => setLineNote(e.target.value)}
                  placeholder={t('settlements.lineNoteHint')}
                />
              </Field>

              <Button ref={addButton} className="w-full" onClick={() => void addLine(tracking)} disabled={busy}>
                {t('settlements.addToStatement')}
              </Button>
            </div>
          )}

          {/* For the statement as a whole, rather than any one parcel: out of
              the way until asked for. */}
          <div className="flex flex-wrap gap-2 border-t border-duch-line pt-3">
            <Button
              variant="ghost"
              className="min-h-9 text-xs"
              onClick={() => setShowAdjustment((open) => !open)}
            >
              {showAdjustment ? '−' : '+'} {t('settlements.showAdjustment')}
            </Button>
            <Button
              variant="ghost"
              className="min-h-9 text-xs"
              onClick={() => setShowNote((open) => !open)}
            >
              {showNote || header.note ? '−' : '+'} {t('settlements.note')}
            </Button>
          </div>

          {/* Charges against the whole statement rather than any one parcel. */}
          {showAdjustment ? (
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto]">
              <Field label={t('settlements.adjustmentLabel')}>
                <Input
                  value={adjLabel}
                  onChange={(e) => setAdjLabel(e.target.value)}
                  placeholder={t('settlements.adjustmentHint')}
                />
              </Field>
              <Field label={t('settlements.adjustmentAmount')} hint={t('settlements.adjustmentSign')}>
                <Input
                  value={adjAmount}
                  onChange={(e) => setAdjAmount(e.target.value)}
                  inputMode="decimal"
                  className="tabular"
                  dir="ltr"
                  placeholder="-200"
                />
              </Field>
              <div className="flex items-end">
                <Button variant="secondary" onClick={() => void addAdjustment()} disabled={busy}>
                  {t('settlements.addAdjustment')}
                </Button>
              </div>
            </div>
          ) : null}

          {/* A note on the statement itself - which day their driver came,
              what was disputed. It outlives whoever typed it in, so one
              already written stays in view. */}
          {showNote || header.note ? (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label={t('settlements.note')}>
                <Input
                  value={settlementNote}
                  onChange={(e) => setSettlementNote(e.target.value)}
                  placeholder={t('settlements.noteHint')}
                />
              </Field>
              <div className="flex items-end">
                <Button variant="secondary" onClick={() => void saveSettlementNote()}>
                  {t('app.save')}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {lines.length === 0 ? (
        <EmptyState title={t('settlements.noLines')} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="border-b border-duch-line bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3 text-start font-semibold">{t('settlements.tracking')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('settlements.order')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('settlements.outcome')}</th>
                <th className="px-4 py-3 text-end font-semibold">{t('settlements.collected')}</th>
                <th className="px-4 py-3 text-end font-semibold">{t('settlements.fee')}</th>
                <th className="px-4 py-3 text-end font-semibold">{t('settlements.net')}</th>
                {isDraft ? <th className="no-print px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-duch-line">
              {lines.map((line) => (
                <tr key={line.line_id}>
                  <td className="tabular px-4 py-3 text-xs" dir="ltr">
                    {line.tracking_number ?? '—'}
                  </td>
                  <td className="min-w-[12rem] px-4 py-3">
                    {/* An adjustment has no order on purpose, so its note is
                        its name. Only a line that should have matched a
                        parcel and did not is a problem worth flagging. */}
                    <span className="block">
                      {line.order_number ? (
                        <OrderLink orderNumber={line.order_number} />
                      ) : line.outcome === 'adjustment' ? (
                        <bdi className="font-semibold">{line.note ?? '—'}</bdi>
                      ) : (
                        <Badge tone="bad">{t('settlements.unmatched')}</Badge>
                      )}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {line.outcome === 'adjustment' ? '' : (line.customer_name ?? '')}
                    </span>
                    {line.mismatch ? (
                      <span className="mt-1 block text-xs font-semibold text-amber-800">
                        {t(`settlementMismatch.${line.mismatch}`)}
                      </span>
                    ) : null}
                    {line.outcome !== 'adjustment' && line.note ? (
                      <bdi className="mt-1 block text-xs text-stone-500">{line.note}</bdi>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {t(`settlementOutcome.${line.outcome}`)}
                  </td>
                  <td className="tabular px-4 py-3 text-end">
                    {formatEGP(Number(line.collected_egp), locale)}
                  </td>
                  <td className="tabular px-4 py-3 text-end text-red-700">
                    {Number(line.fee_egp) > 0 ? `−${formatEGP(Number(line.fee_egp), locale)}` : '—'}
                  </td>
                  <td
                    className={cx(
                      'tabular px-4 py-3 text-end font-bold',
                      Number(line.net_egp) < 0 && 'text-red-700',
                    )}
                  >
                    {formatEGP(Number(line.net_egp), locale)}
                  </td>
                  {isDraft ? (
                    <td className="no-print whitespace-nowrap px-4 py-3 text-end">
                      {line.outcome !== 'adjustment' ? (
                        <Button
                          variant="ghost"
                          className="min-h-9 px-2 text-xs"
                          aria-label={t('settlements.editLine')}
                          onClick={() => setEditing(line)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2 text-xs"
                        aria-label={t('settlements.remove')}
                        onClick={() => void removeLine(line.line_id)}
                      >
                        ✕
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="space-y-3">
        <h2 className="text-sm font-bold">{t('settlements.totals')}</h2>
        <dl className="space-y-1 text-sm">
          <Row label={t('settlements.totalCollected')} value={formatEGP(Number(header.collected_egp), locale)} />
          <Row label={t('settlements.totalFees')} value={`−${formatEGP(Number(header.fees_egp), locale)}`} />
          <Row
            label={t('settlements.totalNet')}
            value={formatEGP(Number(header.net_egp), locale)}
            strong
          />
        </dl>

        {isDraft ? (
          <div className="no-print flex flex-wrap items-end gap-3 border-t border-duch-line pt-3">
            <Field label={t('settlements.netReceived')}>
              <Input
                value={netReceived}
                onChange={(e) => setNetReceived(e.target.value)}
                onBlur={saveNetReceived}
                inputMode="decimal"
                className="tabular w-40"
                dir="ltr"
              />
            </Field>
          </div>
        ) : null}

        {/* The gap between what they say they sent and what the lines explain.
            Refusing to close on a difference is the point: an unexplained one
            is exactly what gets shrugged off. */}
        {header.net_received_egp != null ? (
          balanced ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              {t('settlements.balanced')}
            </p>
          ) : (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {t('settlements.outOfBalance', { amount: formatEGP(difference, locale) })}
            </p>
          )
        ) : null}

        {isDraft ? (
          <Button
            className="no-print w-full"
            disabled={busy || header.net_received_egp == null || !balanced || lines.length === 0}
            onClick={review}
          >
            {busy ? t('settlements.reviewing') : t('settlements.review')}
          </Button>
        ) : null}

        {header.net_received_egp == null && isDraft ? (
          <p className="no-print text-xs text-stone-500">{t('settlements.cannotReview')}</p>
        ) : null}
      </Card>

      {lines.length > 0 ? (
        <AccountantSummary
          header={{
            reference: header.reference,
            received_at: header.received_at,
            net_received_egp: header.net_received_egp,
          }}
          lines={lines}
          products={products}
          breakdown={breakdown}
        />
      ) : null}

      {editing ? (
        <EditLineDialog
          line={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {reopening ? (
        <Modal open title={t('settlements.reopenTitle')} onClose={() => setReopening(false)}>
          <div className="space-y-3">
            <p className="text-sm">{t('settlements.reopenHelp')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setReopening(false)} disabled={busy}>
                {t('app.cancel')}
              </Button>
              <Button onClick={() => void reopen()} disabled={busy}>
                {busy ? t('app.loading') : t('settlements.reopenConfirm')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Correcting one parcel's line without taking it off and keying it again.
 * Turned into a return with the amount left alone, it collected nothing; into
 * a delivery, the goods - as a new line would be.
 */
function EditLineDialog({
  line,
  onClose,
  onSaved,
}: {
  line: StatementLine;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [outcome, setOutcome] = useState(line.outcome);
  const [collected, setCollected] = useState(String(Number(line.collected_egp)));
  const [collectedTouched, setCollectedTouched] = useState(false);
  const [fee, setFee] = useState(String(Number(line.fee_egp)));
  const [note, setNote] = useState(line.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('update_settlement_line', {
      p_line_id: line.line_id,
      p_outcome: outcome === line.outcome ? null : outcome,
      p_collected_egp: collected === '' ? null : Number(collected),
      p_fee_egp: fee === '' ? 0 : Number(fee),
      p_note: note.trim(),
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onSaved();
  }

  return (
    <Modal open title={t('settlements.editLineTitle', { tracking: line.tracking_number ?? '' })} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {ALL_OUTCOMES.filter((value) => value !== 'adjustment').map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setOutcome(value);
                // Left alone, the amount follows the outcome.
                if (!collectedTouched) {
                  setCollected(value === line.outcome ? String(Number(line.collected_egp)) : '');
                }
              }}
              className={cx(
                'min-h-11 rounded-lg border px-3 text-xs font-semibold transition-colors',
                outcome === value
                  ? 'border-duch-ink bg-duch-ink text-white'
                  : 'border-duch-line bg-white text-stone-600 hover:bg-stone-50',
              )}
            >
              {t(`settlementOutcome.${value}`)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('settlements.collected')}>
            <Input
              value={collected}
              onChange={(e) => {
                setCollected(e.target.value);
                setCollectedTouched(true);
              }}
              inputMode="decimal"
              className="tabular"
              dir="ltr"
              placeholder="auto"
            />
          </Field>
          <Field label={t('settlements.fee')}>
            <Input
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              inputMode="decimal"
              className="tabular"
              dir="ltr"
              placeholder="0"
            />
          </Field>
        </div>
        <Field label={t('settlements.lineNote')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('settlements.lineNoteHint')} />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? t('app.loading') : t('app.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One order in the statement search, chosen with a tap. */
function SearchResult({
  orderNumber,
  customer,
  tracking,
  detail,
  onChoose,
}: {
  orderNumber: string;
  customer: string | null;
  tracking: string;
  detail: string;
  onChoose: (tracking: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onChoose(tracking)}
        className="flex w-full items-center gap-3 px-3 py-2 text-start text-sm hover:bg-stone-50"
      >
        <span className="min-w-0 flex-1">
          <span className="tabular block font-semibold" dir="ltr">
            {orderNumber}
          </span>
          <span className="block truncate text-xs text-stone-500">
            <bdi>{customer ?? '—'}</bdi>
            {' · '}
            {detail}
          </span>
        </span>
        <span className="tabular text-xs text-stone-500" dir="ltr">
          {tracking}
        </span>
      </button>
    </li>
  );
}

/**
 * What is in the parcel chosen to go on the statement.
 *
 * The point is checking against their paper before committing: the order, who
 * it went to, what was in it, and what the courier should have collected. If
 * it has already been entered on another statement, that is the first thing
 * shown, because keying the same parcel twice is the likely slip when working
 * down a page of them.
 */
function ParcelCard({ preview }: { preview: ParcelPreview }) {
  const { t, locale } = useLocale();

  if (!preview.found) {
    return (
      <p className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-600">
        {t('settlements.previewNotFound')}
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-duch-line bg-stone-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular text-sm font-extrabold">{preview.order_number}</span>
        <span className="text-sm text-stone-600">{preview.customer_name ?? '—'}</span>
        {preview.already_on ? (
          <Badge tone="bad">
            {t('settlements.previewAlreadyOn', { reference: preview.already_on })}
          </Badge>
        ) : null}
      </div>

      {preview.prepaid ? (
        <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">{t('settlements.previewPrepaid')}</p>
      ) : null}

      <ul className="mt-2 divide-y divide-duch-line">
        {(preview.items ?? []).map((item, index) => (
          <li key={`${item.sku}:${index}`} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="tabular w-8 text-center text-base font-bold">{item.quantity}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{item.title}</span>
              <span className="tabular block text-xs text-stone-500">
                {item.sku}
                {item.variant_title ? ` · ${item.variant_title}` : ''}
              </span>
            </span>
            <span className="tabular text-sm">
              {formatEGP(Number(item.unit_price_egp), locale)}
            </span>
            <span className="tabular w-24 text-end font-semibold">
              {formatEGP(Number(item.total_egp), locale)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-2 space-y-0.5 border-t border-duch-line pt-2 text-xs">
        <div className="flex justify-between">
          <dt className="text-stone-500">{t('settlements.previewGoods')}</dt>
          <dd className="tabular">{formatEGP(Number(preview.goods_egp ?? 0), locale)}</dd>
        </div>
        <div className="flex justify-between text-sm font-bold">
          <dt>{t('settlements.previewExpects')}</dt>
          <dd className="tabular">{formatEGP(Number(preview.expected_egp ?? 0), locale)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx('flex justify-between', strong && 'border-t border-duch-line pt-1 text-base')}>
      <dt className={strong ? 'font-bold' : 'text-stone-600'}>{label}</dt>
      <dd className={cx('tabular', strong ? 'font-extrabold' : 'font-semibold')}>{value}</dd>
    </div>
  );
}
