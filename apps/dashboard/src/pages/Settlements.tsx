import { useCallback, useEffect, useRef, useState } from 'react';
import { can, formatDate, formatEGP } from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { supabase } from '../lib/supabase';
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
  type StatementLine,
} from '../components/AccountantSummary';

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
  line_count: number;
  collected_egp: number;
  fees_egp: number;
  net_egp: number;
  difference_egp: number;
  unmatched_lines: number;
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
  const mayManage = can(identity?.role, 'settlements.manage');

  const [list, setList] = useState<SettlementRow[] | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const [settlements, pending] = await Promise.all([
      supabase.from('v_settlements').select('*').order('received_at', { ascending: false, nullsFirst: false }).limit(100),
      supabase.from('v_awaiting_settlement').select('*').order('days_waiting', { ascending: false }).limit(100),
    ]);
    setList((settlements.data ?? []) as SettlementRow[]);
    setAwaiting((pending.data ?? []) as AwaitingRow[]);
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
            <table className="w-full min-w-[34rem] text-sm">
              <tbody className="divide-y divide-duch-line">
                {awaiting.map((row) => (
                  <tr key={row.order_id}>
                    <td className="tabular px-4 py-2 font-semibold">{row.order_number}</td>
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
      onError(error.message);
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
  const [tracking, setTracking] = useState('');
  const [outcome, setOutcome] = useState<string>('delivered');
  const [collected, setCollected] = useState('');
  const [fee, setFee] = useState('');
  const [netReceived, setNetReceived] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trackingFocused, setTrackingFocused] = useState(false);

  const codeBox = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [head, detail] = await Promise.all([
      supabase.from('v_settlements').select('*').eq('id', settlementId).single(),
      supabase.from('v_settlement_statement').select('*').eq('settlement_id', settlementId),
    ]);
    const row = head.data as SettlementRow | null;
    setHeader(row);
    setNetReceived(row?.net_received_egp == null ? '' : String(row.net_received_egp));
    setLines((detail.data ?? []) as StatementLine[]);
  }, [settlementId]);

  useEffect(() => {
    void load();
  }, [load]);

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
        p_note: null,
      });

      setBusy(false);

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      setTracking('');
      setCollected('');
      setFee('');
      codeBox.current?.focus();
      await load();
    },
    [collected, fee, load, outcome, settlementId],
  );

  useBarcodeScanner((scanned) => void addLine(scanned), {
    enabled: header?.status === 'draft' && !busy && !trackingFocused,
  });

  async function saveNetReceived() {
    const { error: updateError } = await supabase
      .from('courier_settlements')
      .update({ net_received_egp: netReceived === '' ? null : Number(netReceived) })
      .eq('id', settlementId);
    if (updateError) setError(updateError.message);
    else await load();
  }

  async function removeLine(lineId: string) {
    const { error: rpcError } = await supabase.rpc('remove_settlement_line', { p_line_id: lineId });
    if (rpcError) setError(rpcError.message);
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
      setError(rpcError.message);
      return;
    }
    const result = data as { orders_marked_paid: number };
    setToast(t('settlements.reviewed_toast', { count: result.orders_marked_paid }));
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

          {/* Delivered first and selected by default, because most lines on
              their statement are deliveries and the fastest path through a
              page of them is to only touch what differs. */}
          <div className="flex flex-wrap gap-2">
            {ALL_OUTCOMES.map((value) => (
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

          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <Field label={t('settlements.tracking')} hint={t('settlements.trackingHelp')}>
              <Input
                ref={codeBox}
                autoFocus
                dir="ltr"
                className="tabular"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                onFocus={() => setTrackingFocused(true)}
                onBlur={() => setTrackingFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addLine(tracking);
                }}
                autoComplete="off"
              />
            </Field>
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
            <div className="flex items-end">
              <Button onClick={() => void addLine(tracking)} disabled={busy}>
                {t('settlements.add')}
              </Button>
            </div>
          </div>
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
                  <td className="px-4 py-3">
                    <span className="tabular block font-semibold">
                      {line.order_number ?? (
                        <Badge tone="bad">{t('settlements.unmatched')}</Badge>
                      )}
                    </span>
                    <span className="block text-xs text-stone-500">{line.customer_name ?? ''}</span>
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
                    <td className="no-print px-4 py-3 text-end">
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2 text-xs"
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
        />
      ) : null}
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
