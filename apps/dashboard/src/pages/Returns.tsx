import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { can, formatDate } from '@duch/shared';
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

const RETURN_REASONS = [
  'no_response',
  'refused_after_inspection',
  'refused_unopened',
  'wrong_address',
  'delivery_timeout',
  'wrong_size',
  'not_as_expected',
  'faulty',
  'wrong_item_sent',
] as const;

interface InboundRow {
  return_id: string;
  status: string;
  reason: string | null;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  governorate: string | null;
  tracking_number: string | null;
  days_since_reported: number;
  units_expected: number;
  items: string | null;
}

interface DiscrepancyRow {
  return_id: string;
  order_number: string;
  tracking_number: string | null;
  sku: string;
  quantity_expected: number;
  quantity_received: number;
  quantity_missing: number;
  condition_note: string | null;
  customer_name: string | null;
}

interface LookupLine {
  return_line_id: string;
  sku: string;
  title: string | null;
  variant_title: string | null;
  quantity_expected: number;
}

interface OrderLine {
  order_line_item_id: string;
  sku: string;
  title: string;
  variant_title: string | null;
  quantity: number;
}

interface Lookup {
  state:
    | 'not_found'
    | 'already_received'
    | 'ready_to_receive'
    | 'needs_failure_record'
    | 'not_returnable';
  tracking_number: string;
  order: {
    id: string;
    order_number: string;
    customer_name: string | null;
    customer_phone: string | null;
    governorate: string | null;
  };
  return: { id: string; reason: string | null; status: string } | null;
  lines: LookupLine[];
  order_lines: OrderLine[];
}

interface Session {
  parcels: number;
  back: number;
  damaged: number;
  missing: number;
}

interface CheckinDayRow {
  received_date: string;
  parcels: number;
  units_back_in_stock: number;
  units_damaged: number;
  units_missing: number;
}

export function Returns() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayCheckIn = can(identity?.role, 'orders.pack');

  const [tab, setTab] = useState<'inbound' | 'short'>('inbound');
  const [inbound, setInbound] = useState<InboundRow[] | null>(null);
  const [short, setShort] = useState<DiscrepancyRow[] | null>(null);
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // A running tally of the pile worked through so far. The point of the last
  // number is that somebody notices it.
  const [session, setSession] = useState<Session>({ parcels: 0, back: 0, damaged: 0, missing: 0 });
  const [scanBoxFocused, setScanBoxFocused] = useState(false);
  // Everyone's check-ins, not just this browser tab's - the session tally
  // above resets the moment the page reloads, which a phone does on its own.
  const [days, setDays] = useState<CheckinDayRow[] | null>(null);

  const scanBox = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [inboundResult, shortResult, daysResult] = await Promise.all([
      supabase.from('v_returns_inbound').select('*').order('days_since_reported', { ascending: false }),
      supabase.from('v_return_discrepancies').select('*').limit(200),
      supabase
        .from('v_return_checkin_summary')
        .select('*')
        .order('received_date', { ascending: false })
        .limit(7),
    ]);
    setInbound((inboundResult.data ?? []) as InboundRow[]);
    setShort((shortResult.data ?? []) as DiscrepancyRow[]);
    setDays((daysResult.data ?? []) as CheckinDayRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const find = useCallback(
    async (tracking: string) => {
      const trimmed = tracking.trim();
      if (!trimmed) return;

      setLooking(true);
      setError(null);
      setDone(null);

      const { data, error: rpcError } = await supabase.rpc('lookup_return_by_tracking', {
        p_tracking: trimmed,
      });

      setLooking(false);
      setCode('');

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      const result = data as Lookup;

      if (result.state === 'not_found') {
        setError(t('returns.notFound'));
        return;
      }
      if (result.state === 'already_received') {
        setError(t('returns.alreadyReceived', { orderNumber: result.order.order_number }));
        return;
      }
      if (result.state === 'not_returnable') {
        setError(t('returns.notReturnable', { orderNumber: result.order.order_number }));
        return;
      }

      setLookup(result);
    },
    [t],
  );

  // The parcel has a barcode on it. Scanning is the whole workflow: pick one
  // off the pile, scan, count what is inside, put it down, pick up the next.
  //
  // Switched off while the scan box itself has focus, because then the field
  // already receives the characters and handles its own Enter. Leaving both
  // active means a fast typist can have the document listener fire on a
  // half-finished buffer while the field holds the complete code.
  useBarcodeScanner((scanned) => void find(scanned), {
    enabled: mayCheckIn && !lookup && !looking && !scanBoxFocused,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold">{t('returns.title')}</h1>

      {mayCheckIn ? (
        <Card className="space-y-3">
          <Field label={t('returns.scanPrompt')}>
            <Input
              ref={scanBox}
              autoFocus
              dir="ltr"
              className="tabular text-lg"
              placeholder={t('returns.scanPlaceholder')}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void find(code);
              }}
              onFocus={() => setScanBoxFocused(true)}
              onBlur={() => setScanBoxFocused(false)}
              autoComplete="off"
            />
          </Field>

          {looking ? <Spinner /> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              {done}
            </p>
          ) : null}

          {session.parcels > 0 ? (
            <dl className="grid grid-cols-4 gap-2 border-t border-duch-line pt-3 text-center">
              <Tally label={t('returns.sessionParcels')} value={session.parcels} />
              <Tally label={t('returns.sessionBack')} value={session.back} tone="good" />
              <Tally label={t('returns.sessionDamaged')} value={session.damaged} tone="warn" />
              <Tally label={t('returns.sessionMissing')} value={session.missing} tone="bad" />
            </dl>
          ) : null}
        </Card>
      ) : null}

      {mayCheckIn && days && days.length > 0 ? (
        <Card className="overflow-x-auto">
          <h2 className="mb-3 text-sm font-bold">{t('returns.everyoneTitle')}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-duch-line text-xs text-stone-500">
                <th className="py-2 text-start font-bold">{t('reports.when')}</th>
                <th className="py-2 text-end font-bold">{t('returns.sessionParcels')}</th>
                <th className="py-2 text-end font-bold">{t('returns.sessionBack')}</th>
                <th className="py-2 text-end font-bold">{t('returns.sessionDamaged')}</th>
                <th className="py-2 text-end font-bold">{t('returns.sessionMissing')}</th>
              </tr>
            </thead>
            <tbody>
              {days.map((row) => (
                <tr key={row.received_date} className="border-b border-stone-100">
                  <td className="tabular py-2 text-xs" dir="ltr">
                    {formatDate(row.received_date, locale)}
                  </td>
                  <td className="tabular py-2 text-end">{row.parcels}</td>
                  <td className="tabular py-2 text-end text-emerald-600 font-semibold">
                    {row.units_back_in_stock}
                  </td>
                  <td className="tabular py-2 text-end text-amber-600 font-semibold">
                    {row.units_damaged}
                  </td>
                  <td
                    className={cx(
                      'tabular py-2 text-end font-semibold',
                      row.units_missing > 0 && 'text-red-600',
                    )}
                  >
                    {row.units_missing}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <div className="flex gap-2">
        {(['inbound', 'short'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cx(
              'flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors',
              tab === key
                ? 'bg-duch-ink text-white'
                : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
            )}
          >
            {t(key === 'inbound' ? 'returns.tabInbound' : 'returns.tabDiscrepancies')}
            <span
              className={cx(
                'tabular rounded-full px-2 py-0.5 text-xs',
                tab === key ? 'bg-white/20' : 'bg-stone-100',
              )}
            >
              {key === 'inbound' ? (inbound?.length ?? 0) : (short?.length ?? 0)}
            </span>
          </button>
        ))}
      </div>

      {tab === 'inbound' ? (
        !inbound ? (
          <Spinner label={t('app.loading')} />
        ) : inbound.length === 0 ? (
          <EmptyState title={t('returns.emptyInbound')} />
        ) : (
          <div className="space-y-3">
            {inbound.map((row) => (
              <Card key={row.return_id} className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular text-sm font-extrabold">{row.order_number}</span>
                    {row.reason ? (
                      <Badge tone="warn">{t(`returnReason.${row.reason}`)}</Badge>
                    ) : null}
                    {/* A refusal normally lands within two or three days. */}
                    {row.days_since_reported > 7 ? (
                      <Badge tone="bad">
                        {t('returns.daysWaiting', { count: Math.floor(row.days_since_reported) })}
                      </Badge>
                    ) : (
                      <span className="text-xs text-stone-500">
                        {t('returns.daysWaiting', { count: Math.floor(row.days_since_reported) })}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm font-semibold">{row.customer_name ?? '—'}</p>
                  <p className="tabular text-xs text-stone-500" dir="ltr">
                    {row.tracking_number ?? '—'}
                  </p>
                  <p className="tabular mt-1 text-xs text-stone-600">{row.items ?? '—'}</p>
                </div>
                <Badge>{t('returns.unitsExpected', { count: row.units_expected })}</Badge>
              </Card>
            ))}
          </div>
        )
      ) : !short ? (
        <Spinner label={t('app.loading')} />
      ) : short.length === 0 ? (
        <EmptyState title={t('returns.emptyDiscrepancies')} />
      ) : (
        <div className="space-y-3">
          {short.map((row, index) => (
            <Card key={`${row.return_id}:${row.sku}:${index}`} className="border-red-200 bg-red-50">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <span className="tabular text-sm font-extrabold">{row.order_number}</span>
                  <p className="tabular text-xs text-stone-600" dir="ltr">
                    {row.tracking_number ?? '—'}
                  </p>
                  <p className="tabular mt-1 text-sm font-semibold">{row.sku}</p>
                  {row.condition_note ? (
                    <p className="text-xs text-stone-600">{row.condition_note}</p>
                  ) : null}
                </div>
                <dl className="tabular flex gap-5 text-center text-sm">
                  <div>
                    <dt className="text-xs text-stone-500">{t('returns.expectedQty')}</dt>
                    <dd className="text-lg font-extrabold">{row.quantity_expected}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-500">{t('returns.missing')}</dt>
                    <dd className="text-lg font-extrabold text-red-700">{row.quantity_missing}</dd>
                  </div>
                </dl>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CheckInDialog
        lookup={lookup}
        onClose={() => setLookup(null)}
        onDone={(summary) => {
          setLookup(null);
          setDone(t('returns.checkedIn', { orderNumber: summary.orderNumber }));
          setSession((s) => ({
            parcels: s.parcels + 1,
            back: s.back + summary.back,
            damaged: s.damaged + summary.damaged,
            missing: s.missing + summary.missing,
          }));
          void load();
          scanBox.current?.focus();
        }}
      />
    </div>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd
        className={cx(
          'tabular text-xl font-extrabold',
          tone === 'good' && 'text-emerald-600',
          tone === 'warn' && 'text-amber-600',
          tone === 'bad' && value > 0 && 'text-red-600',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// --- Counting what is actually in the parcel --------------------------------

interface LineCount {
  return_line_id: string;
  sku: string;
  label: string;
  expected: number;
  resellable: number;
  damaged: number;
}

function CheckInDialog({
  lookup,
  onClose,
  onDone,
}: {
  lookup: Lookup | null;
  onClose: () => void;
  onDone: (summary: { orderNumber: string; back: number; damaged: number; missing: number }) => void;
}) {
  const { t } = useLocale();
  const [reason, setReason] = useState<string>('refused_after_inspection');
  const [counts, setCounts] = useState<LineCount[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReason = lookup?.state === 'needs_failure_record';

  useEffect(() => {
    if (!lookup) return;
    setError(null);
    setNote('');
    setReason('refused_after_inspection');

    // Everything that went out is assumed to have come back sellable, because
    // that is what usually happens: the parcel was opened at the door and just
    // needs repackaging. The packer only has to touch the numbers that are
    // wrong, which is the difference between a ten-second job and a two-minute
    // one across a pile of parcels.
    if (lookup.state === 'ready_to_receive') {
      setCounts(
        lookup.lines.map((line) => ({
          return_line_id: line.return_line_id,
          sku: line.sku,
          label: [line.title, line.variant_title].filter(Boolean).join(' · '),
          expected: line.quantity_expected,
          resellable: line.quantity_expected,
          damaged: 0,
        })),
      );
    } else {
      setCounts(
        lookup.order_lines.map((line) => ({
          return_line_id: '',
          sku: line.sku,
          label: [line.title, line.variant_title].filter(Boolean).join(' · '),
          expected: line.quantity,
          resellable: line.quantity,
          damaged: 0,
        })),
      );
    }
  }, [lookup]);

  const totals = useMemo(() => {
    const back = counts.reduce((sum, c) => sum + c.resellable, 0);
    const damaged = counts.reduce((sum, c) => sum + c.damaged, 0);
    const expected = counts.reduce((sum, c) => sum + c.expected, 0);
    return { back, damaged, missing: expected - back - damaged };
  }, [counts]);

  if (!lookup) return null;
  const target = lookup;

  function setCount(index: number, field: 'resellable' | 'damaged', value: number) {
    setCounts((current) =>
      current.map((line, i) => {
        if (i !== index) return line;
        const next = { ...line, [field]: Math.max(0, value) };
        // Received can never exceed what was sent; the database enforces this
        // too, but catching it here keeps the packer out of an error message.
        if (next.resellable + next.damaged > next.expected) {
          const other = field === 'resellable' ? next.damaged : next.resellable;
          next[field] = Math.max(0, next.expected - other);
        }
        return next;
      }),
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);

    let returnId = target.return?.id ?? null;
    let lineIds = counts.map((c) => c.return_line_id);

    // The failure was never recorded, so record it now. This creates the
    // return with a line per item, which is what the check-in then fills in.
    if (needsReason) {
      const { data, error: failError } = await supabase.rpc(
        'record_delivery_failure_by_tracking',
        { p_tracking: target.tracking_number, p_reason: reason, p_note: note || null },
      );

      if (failError) {
        setBusy(false);
        setError(failError.message);
        return;
      }

      returnId = (data as { id: string }).id;

      const { data: fresh, error: lookupError } = await supabase.rpc(
        'lookup_return_by_tracking',
        { p_tracking: target.tracking_number },
      );

      if (lookupError) {
        setBusy(false);
        setError(lookupError.message);
        return;
      }

      lineIds = (fresh as Lookup).lines.map((l) => l.return_line_id);
    }

    const { error: receiveError } = await supabase.rpc('receive_return', {
      p_return_id: returnId,
      p_lines: counts.map((c, i) => ({
        return_line_id: lineIds[i],
        quantity_resellable: c.resellable,
        quantity_damaged: c.damaged,
        condition_note: c.damaged > 0 ? note || null : null,
      })),
      p_note: note || null,
    });

    setBusy(false);

    if (receiveError) {
      setError(receiveError.message);
      return;
    }

    onDone({
      orderNumber: target.order.order_number,
      back: totals.back,
      damaged: totals.damaged,
      missing: totals.missing,
    });
  }

  return (
    <Modal
      open
      title={
        needsReason
          ? t('returns.needsFailureTitle', { orderNumber: target.order.order_number })
          : t('returns.checkInTitle', { orderNumber: target.order.order_number })
      }
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="tabular rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600" dir="ltr">
          {target.tracking_number}
        </p>

        {needsReason ? (
          <div className="space-y-2">
            <p className="text-xs text-stone-500">{t('returns.needsFailureHelp')}</p>
            <div className="grid grid-cols-2 gap-2">
              {RETURN_REASONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setReason(value)}
                  className={cx(
                    'min-h-11 rounded-lg border px-3 text-start text-xs font-semibold transition-colors',
                    reason === value
                      ? 'border-duch-ink bg-duch-ink text-white'
                      : 'border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                  )}
                >
                  {t(`returnReason.${value}`)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <ul className="divide-y divide-duch-line">
          {counts.map((line, index) => (
            <li key={`${line.sku}:${index}`} className="py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {line.label || line.sku}
                  </span>
                  <span className="tabular block text-xs text-stone-500">{line.sku}</span>
                </span>
                <span className="tabular text-xs text-stone-500">
                  {t('returns.expectedQty')} {line.expected}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-3">
                <Counter
                  label={t('returns.resellable')}
                  value={line.resellable}
                  max={line.expected}
                  onChange={(v) => setCount(index, 'resellable', v)}
                />
                <Counter
                  label={t('returns.damaged')}
                  value={line.damaged}
                  max={line.expected}
                  onChange={(v) => setCount(index, 'damaged', v)}
                  tone="warn"
                />
              </div>
            </li>
          ))}
        </ul>

        <p className="text-xs text-stone-500">{t('returns.resellableHelp')}</p>

        {totals.missing > 0 ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {t('returns.shortWarning', { count: totals.missing })}
          </p>
        ) : null}

        <Field label={totals.damaged > 0 ? t('returns.condition') : t('queue.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('returns.confirming') : t('returns.confirm')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Counter({
  label,
  value,
  max,
  onChange,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
  tone?: 'warn';
}) {
  return (
    <div>
      <span className="mb-1 block text-xs font-semibold text-stone-600">{label}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="secondary"
          className="min-h-11 w-11 px-0"
          onClick={() => onChange(value - 1)}
          aria-label="-"
        >
          −
        </Button>
        <span
          className={cx(
            'tabular w-10 text-center text-lg font-extrabold',
            tone === 'warn' && value > 0 && 'text-amber-600',
          )}
        >
          {value}
        </span>
        <Button
          variant="secondary"
          className="min-h-11 w-11 px-0"
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          aria-label="+"
        >
          +
        </Button>
      </div>
    </div>
  );
}
