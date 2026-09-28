import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { can, formatEGP } from '@duch/shared';
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
import { Invoice } from '../components/Invoice';
import { PackingSlip, type SlipOrder } from '../components/PackingSlip';

type FulfillmentStatus =
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'ready_to_pack'
  | 'packed'
  | 'awaiting_pickup'
  | 'out_for_delivery';

interface QueueRow {
  order_id: string;
  order_number: string;
  channel: string;
  fulfillment_status: FulfillmentStatus;
  payment_status: string;
  payment_method: string | null;
  total_egp: number;
  shipping_egp: number;
  note: string | null;
  created_at: string;
  hold_until: string | null;
  confirmation_outcome: string | null;
  confirmation_attempts: number;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  address_line1: string | null;
  city: string | null;
  governorate: string | null;
  requires_prepayment: boolean;
  age_hours: number;
  unit_count: number;
  items: string | null;
  shipment_id: string | null;
  tracking_number: string | null;
  cod_amount_egp: number | null;
  customer_prior_refusals: number;
  courier: string | null;
  driver_name: string | null;
  handed_over_at: string | null;
}

/**
 * Everything that can be waiting on someone, in the order it happens. The
 * view only returns out_for_delivery for our own drivers, so that stage is
 * cash still to be handed in - never a parcel with Accurate.
 */
const STAGES = [
  { key: 'toConfirm', statuses: ['awaiting_confirmation'] },
  { key: 'toPack', statuses: ['confirmed', 'ready_to_pack'] },
  { key: 'packed', statuses: ['packed'] },
  { key: 'awaitingPickup', statuses: ['awaiting_pickup'] },
  { key: 'withOurDriver', statuses: ['out_for_delivery'] },
] as const;

type StageKey = (typeof STAGES)[number]['key'];

export function PackingQueue() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  // Sales staff run the confirmation calls; packing staff do the physical
  // work. Showing everyone every button means half the shop taps things the
  // database then refuses, which reads as the app being broken.
  const mayPack = can(identity?.role, 'orders.pack');
  // Recording cash as received is settling money, so it follows who may
  // settle a paying-later order - not who packs.
  const maySettle = can(identity?.role, 'sales.create');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sectionRefs = useRef<Partial<Record<StageKey, HTMLElement | null>>>({});
  const [calling, setCalling] = useState<QueueRow | null>(null);
  const [shipping, setShipping] = useState<QueueRow | null>(null);
  const [sendingOut, setSendingOut] = useState<QueueRow | null>(null);
  const [slip, setSlip] = useState<SlipOrder | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);

  const load = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from('v_packing_queue')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(500);

    if (queryError) {
      setError(queryError.message);
      return;
    }
    setError(null);
    setRows((data ?? []) as QueueRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The person running this has the CRM open all day, so new orders arrive
  // rather than being waited for. A change to any order reloads the list; the
  // volume here is a handful an hour, not a stream, so a refetch is simpler
  // and more obviously correct than patching rows in place.
  useEffect(() => {
    const channel = supabase
      .channel('packing-queue')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        (payload) => {
          if (payload.eventType === 'INSERT') setNewCount((n) => n + 1);
          void load();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const byStage = useMemo(() => {
    const groups = {} as Record<StageKey, QueueRow[]>;
    for (const s of STAGES) groups[s.key] = [];
    for (const row of rows ?? []) {
      const match = STAGES.find((s) => (s.statuses as readonly string[]).includes(row.fulfillment_status));
      if (match) groups[match.key].push(row);
    }
    return groups;
  }, [rows]);

  // PromiseLike rather than Promise: supabase.rpc() returns a builder that is
  // thenable but is not an actual Promise.
  async function run(
    row: QueueRow,
    fn: () => PromiseLike<{ error: { code?: string; message: string } | null }>,
  ) {
    setBusyId(row.order_id);
    setError(null);
    const { error: rpcError } = await fn();
    setBusyId(null);
    if (rpcError) {
      setError(describeError(rpcError, t));
      return;
    }
    await load();
  }

  if (slip) return <PackingSlip order={slip} onClose={() => setSlip(null)} />;
  if (invoiceId) return <Invoice orderId={invoiceId} onClose={() => setInvoiceId(null)} />;
  if (!rows) return <Spinner label={t('app.loading')} />;

  const emptyMessage: Record<StageKey, string> = {
    toConfirm: t('queue.emptyConfirm'),
    toPack: t('queue.emptyPack'),
    packed: t('queue.emptyPacked'),
    awaitingPickup: t('queue.emptyPickup'),
    withOurDriver: t('queue.emptyWithOurDriver'),
  };

  function renderCard(row: QueueRow) {
    return (
            <Card key={row.order_id} className="space-y-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular text-sm font-extrabold">{row.order_number}</span>
                    <Badge tone={row.payment_method === 'cod' ? 'warn' : 'good'}>
                      {t(`payment.${row.payment_method ?? 'cod'}`)}
                    </Badge>
                    <span className="text-xs text-stone-500">{ageLabel(row.age_hours, t)}</span>
                  </div>

                  <p className="mt-1 text-sm font-semibold">
                    {row.customer_name ?? t('queue.walkIn')}
                  </p>
                  {row.customer_phone ? (
                    <a
                      href={`tel:${row.customer_phone}`}
                      dir="ltr"
                      className="tabular block text-sm text-duch-accent underline"
                    >
                      {row.customer_phone}
                    </a>
                  ) : (
                    <p className="text-sm text-stone-500">{t('queue.noPhone')}</p>
                  )}
                  {row.governorate ? (
                    <p className="text-xs text-stone-500">
                      {[row.city, row.governorate].filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                </div>

                <div className="text-end">
                  <p className="tabular text-base font-extrabold">
                    {formatEGP(
                      Number(row.cod_amount_egp ?? Number(row.total_egp) + Number(row.shipping_egp)),
                      locale,
                    )}
                  </p>
                  <p className="tabular text-xs text-stone-500">
                    {row.unit_count} · {t(`paymentStatus.${row.payment_status}`)}
                  </p>
                </div>
              </div>

              <p className="tabular rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
                {row.items ?? '—'}
              </p>

              {/* Who is holding this order's cash, and since when - the same
                  question the courier custody list answers for Accurate. */}
              {row.fulfillment_status === 'out_for_delivery' ? (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <p className="font-bold">
                    {t('queue.withDriver', { name: row.driver_name ?? '—' })}
                    {row.handed_over_at ? (
                      <span className="ms-2 font-normal">
                        {ageLabel((Date.now() - new Date(row.handed_over_at).getTime()) / 3_600_000, t)}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5">{t('queue.refusedHint')}</p>
                </div>
              ) : null}

              {/* The things worth knowing before spending a courier run. */}
              {row.customer_prior_refusals > 0 || row.requires_prepayment || row.confirmation_attempts > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {row.customer_prior_refusals > 0 ? (
                    <Badge tone="bad">
                      {t('queue.priorRefusals', { count: row.customer_prior_refusals })}
                    </Badge>
                  ) : null}
                  {row.requires_prepayment ? (
                    <Badge tone="bad">{t('queue.requiresPrepayment')}</Badge>
                  ) : null}
                  {row.confirmation_attempts > 0 ? (
                    <Badge tone="warn">
                      {t('queue.attempts', { count: row.confirmation_attempts })}
                    </Badge>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2 border-t border-duch-line pt-3">
                {row.fulfillment_status === 'awaiting_confirmation' ? (
                  <Button onClick={() => setCalling(row)} disabled={busyId === row.order_id}>
                    {t('queue.call')}
                  </Button>
                ) : null}

                {mayPack &&
                (row.fulfillment_status === 'ready_to_pack' ||
                  row.fulfillment_status === 'confirmed') ? (
                  <Button
                    disabled={busyId === row.order_id}
                    onClick={() =>
                      run(row, () => supabase.rpc('mark_order_packed', { p_order_id: row.order_id }))
                    }
                  >
                    {t('queue.markPacked')}
                  </Button>
                ) : null}

                {mayPack && row.fulfillment_status === 'packed' ? (
                  <>
                    <Button onClick={() => setShipping(row)} disabled={busyId === row.order_id}>
                      {t('queue.createShipment')}
                    </Button>
                    <Button onClick={() => setSendingOut(row)} disabled={busyId === row.order_id}>
                      {t('queue.deliverOurselves')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busyId === row.order_id}
                      onClick={() =>
                        run(row, () =>
                          supabase.rpc('unpack_order', {
                            p_order_id: row.order_id,
                            p_reason: null,
                          }),
                        )
                      }
                    >
                      {t('queue.unpack')}
                    </Button>
                  </>
                ) : null}

                {maySettle && row.fulfillment_status === 'out_for_delivery' ? (
                  <Button
                    disabled={busyId === row.order_id}
                    onClick={() =>
                      run(row, () =>
                        supabase.rpc('complete_own_delivery', { p_order_id: row.order_id }),
                      )
                    }
                  >
                    {row.payment_method === 'cod' ? t('queue.cashReceived') : t('queue.delivered')}
                  </Button>
                ) : null}

                {mayPack && row.fulfillment_status === 'awaiting_pickup' && row.shipment_id ? (
                  <Button
                    disabled={busyId === row.order_id}
                    onClick={() =>
                      run(row, () =>
                        supabase.rpc('mark_shipment_handed_over', {
                          p_shipment_id: row.shipment_id,
                        }),
                      )
                    }
                  >
                    {t('queue.handOver')}
                  </Button>
                ) : null}

                {/* Smaller than the action buttons, so a card's buttons fit one
                    line on a phone - with every stage on one page, card
                    height is what decides how much scrolling there is. */}
                <Button
                  variant="secondary"
                  className="ms-auto min-h-9 px-3 text-xs"
                  onClick={() => setSlip(toSlip(row))}
                >
                  {t('queue.printSlip')}
                </Button>

                <Button
                  variant="secondary"
                  className="min-h-9 px-3 text-xs"
                  onClick={() => setInvoiceId(row.order_id)}
                >
                  {t('queue.printInvoice')}
                </Button>
              </div>
            </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-extrabold">{t('queue.title')}</h1>
        {newCount > 0 ? (
          <button
            type="button"
            onClick={() => setNewCount(0)}
            className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white"
          >
            {t('queue.newOrders', { count: newCount })}
          </button>
        ) : null}
        <Button variant="ghost" className="ms-auto text-xs" onClick={() => void load()}>
          {t('queue.refresh')}
        </Button>
      </div>

      {/* Every stage on one page, in the order the work happens. The chips
          are a count and a shortcut, not a filter - nothing is hidden. */}
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex min-w-max gap-2">
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() =>
                sectionRefs.current[s.key]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              className={cx(
                'flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors',
                byStage[s.key].length > 0
                  ? 'border-duch-ink bg-white text-duch-ink hover:bg-stone-50'
                  : 'border-duch-line bg-white text-stone-400',
              )}
            >
              {t(`queue.${s.key}`)}
              <span
                className={cx(
                  'tabular rounded-full px-2 py-0.5 text-xs',
                  byStage[s.key].length > 0 ? 'bg-duch-ink text-white' : 'bg-stone-100',
                )}
              >
                {byStage[s.key].length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {rows.length === 0 ? (
        <EmptyState title={t('queue.empty')} />
      ) : (
        STAGES.map((s) => (
          <section
            key={s.key}
            ref={(el) => {
              sectionRefs.current[s.key] = el;
            }}
            className="scroll-mt-20 space-y-3"
          >
            <h2 className="flex items-center gap-2 border-b border-duch-line pb-2 text-sm font-extrabold">
              {t(`queue.${s.key}`)}
              <span className="tabular rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold">
                {byStage[s.key].length}
              </span>
            </h2>
            {byStage[s.key].length === 0 ? (
              <p className="text-xs text-stone-400">{emptyMessage[s.key]}</p>
            ) : (
              byStage[s.key].map(renderCard)
            )}
          </section>
        ))
      )}

      <CallDialog
        row={calling}
        onClose={() => setCalling(null)}
        onDone={() => {
          setCalling(null);
          void load();
        }}
      />

      <ShipmentDialog
        row={shipping}
        onClose={() => setShipping(null)}
        onDone={() => {
          setShipping(null);
          void load();
        }}
      />

      <OwnDeliveryDialog
        row={sendingOut}
        onClose={() => setSendingOut(null)}
        onDone={() => {
          setSendingOut(null);
          void load();
        }}
      />
    </div>
  );
}

/**
 * Database errors reach the browser in English, from Postgres. The ones a
 * person can actually act on get a translated message; anything unexpected
 * still shows the original, because a vague "something went wrong" is worse
 * than an untranslated detail when you are trying to work out what happened.
 */
function describeError(
  error: { code?: string; message: string },
  t: (k: string, p?: Record<string, unknown>) => string,
): string {
  if (error.code === '42501') return t('auth.noAccess');
  return error.message;
}

function toSlip(row: QueueRow): SlipOrder {
  return {
    order_id: row.order_id,
    order_number: row.order_number,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    address_line1: row.address_line1,
    city: row.city,
    governorate: row.governorate,
    total_egp: row.total_egp,
    shipping_egp: row.shipping_egp,
    cod_amount_egp: row.cod_amount_egp,
    payment_method: row.payment_method,
    tracking_number: row.tracking_number,
    created_at: row.created_at,
    note: row.note,
  };
}

function ageLabel(hours: number, t: (k: string, p?: Record<string, unknown>) => string): string {
  const h = Math.floor(hours);
  if (h < 48) return t('queue.ageHours', { count: h });
  return t('queue.ageDays', { count: Math.floor(h / 24) });
}

// --- The confirmation call --------------------------------------------------

function CallDialog({
  row,
  onClose,
  onDone,
}: {
  row: QueueRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [note, setNote] = useState('');
  const [holdUntil, setHoldUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNote('');
    setHoldUntil('');
    setError(null);
  }, [row?.order_id]);

  if (!row) return null;
  const target = row;

  async function apply(outcome: string) {
    if (outcome === 'asked_to_delay' && !holdUntil) {
      setError(t('queue.holdUntil'));
      return;
    }

    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('record_confirmation_call', {
      p_order_id: target.order_id,
      p_outcome: outcome,
      p_note: note || null,
      p_hold_until: outcome === 'asked_to_delay' ? holdUntil : null,
    });

    setBusy(false);
    if (rpcError) {
      setError(describeError(rpcError, t));
      return;
    }
    onDone();
  }

  const outcomes = [
    { key: 'confirmed', label: t('queue.outcomeConfirmed'), tone: 'primary' as const },
    { key: 'unreachable', label: t('queue.outcomeUnreachable'), tone: 'secondary' as const },
    { key: 'asked_to_delay', label: t('queue.outcomeDelay'), tone: 'secondary' as const },
    { key: 'cancelled_by_customer', label: t('queue.outcomeCancelled'), tone: 'danger' as const },
  ];

  return (
    <Modal open title={t('queue.callTitle', { orderNumber: target.order_number })} onClose={onClose}>
      <div className="space-y-3">
        {target.customer_phone ? (
          <a
            href={`tel:${target.customer_phone}`}
            dir="ltr"
            className="tabular block rounded-lg bg-stone-50 px-3 py-3 text-center text-lg font-bold text-duch-accent underline"
          >
            {target.customer_phone}
          </a>
        ) : (
          <p className="rounded-lg bg-stone-50 px-3 py-2 text-sm">{t('queue.noPhone')}</p>
        )}

        <Field label={t('queue.holdUntil')} hint={t('queue.holdUntilHelp')}>
          <Input
            type="date"
            value={holdUntil}
            onChange={(event) => setHoldUntil(event.target.value)}
          />
        </Field>

        <Field label={t('queue.note')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        <p className="text-xs text-stone-500">{t('queue.outcomeHelp')}</p>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="space-y-2">
          {outcomes.map((outcome) => (
            <Button
              key={outcome.key}
              variant={outcome.tone === 'primary' ? 'primary' : outcome.tone}
              className="w-full"
              disabled={busy}
              onClick={() => apply(outcome.key)}
            >
              {outcome.label}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// --- Creating the shipment --------------------------------------------------

function ShipmentDialog({
  row,
  onClose,
  onDone,
}: {
  row: QueueRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [tracking, setTracking] = useState('');
  const [service, setService] = useState('');
  const [zone, setZone] = useState('');
  const [subzone, setSubzone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trackingBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTracking('');
    setService('');
    setZone('');
    setSubzone('');
    setError(null);
  }, [row?.order_id]);

  // The courier's label has a barcode on it. Scanning beats typing a
  // fifteen-character code, and mistyping one means a parcel that cannot be
  // traced later.
  useBarcodeScanner((code) => setTracking(code), { enabled: Boolean(row) && !busy });

  if (!row) return null;
  const target = row;

  async function submit() {
    if (!tracking.trim()) {
      setError(t('queue.trackingNumber'));
      return;
    }

    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('record_shipment', {
      p_order_id: target.order_id,
      p_tracking_number: tracking.trim(),
      p_cod_amount_egp: null,
      p_service_type: service || null,
      p_zone: zone || null,
      p_subzone: subzone || null,
    });

    setBusy(false);
    if (rpcError) {
      setError(describeError(rpcError, t));
      return;
    }
    onDone();
  }

  return (
    <Modal
      open
      title={t('queue.shipmentTitle', { orderNumber: target.order_number })}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Field label={t('queue.trackingNumber')} hint={t('queue.trackingHelp')}>
          <Input
            ref={trackingBox}
            autoFocus
            dir="ltr"
            className="tabular"
            value={tracking}
            onChange={(event) => setTracking(event.target.value)}
            autoComplete="off"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('queue.zone')}>
            <Input value={zone} onChange={(event) => setZone(event.target.value)} />
          </Field>
          <Field label={t('queue.subzone')}>
            <Input value={subzone} onChange={(event) => setSubzone(event.target.value)} />
          </Field>
        </div>

        <Field label={t('queue.serviceType')}>
          <Input value={service} onChange={(event) => setService(event.target.value)} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('app.loading') : t('queue.createShipment')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Delivering it ourselves ------------------------------------------------

function OwnDeliveryDialog({
  row,
  onClose,
  onDone,
}: {
  row: QueueRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [driver, setDriver] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!row) return;
    setDriver('');
    setError(null);

    // Staff names plus anyone who has delivered for us before, so the usual
    // driver is one tap. The field still takes any name: the worker who
    // delivers may not have a CRM login at all.
    let cancelled = false;
    void Promise.all([
      supabase.from('staff').select('full_name').eq('is_active', true),
      supabase
        .from('shipments')
        .select('driver_name')
        .eq('courier', 'own')
        .not('driver_name', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50),
    ]).then(([staff, drivers]) => {
      if (cancelled) return;
      const names = [
        ...(drivers.data ?? []).map((d) => d.driver_name as string),
        ...(staff.data ?? []).map((s) => s.full_name as string),
      ];
      setSuggestions([...new Set(names.filter(Boolean))]);
    });

    return () => {
      cancelled = true;
    };
  }, [row?.order_id]);

  if (!row) return null;
  const target = row;

  async function submit() {
    if (!driver.trim()) {
      setError(t('queue.driverName'));
      return;
    }

    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('start_own_delivery', {
      p_order_id: target.order_id,
      p_driver_name: driver.trim(),
    });

    setBusy(false);
    if (rpcError) {
      setError(describeError(rpcError, t));
      return;
    }
    onDone();
  }

  return (
    <Modal
      open
      title={t('queue.ownDeliveryTitle', { orderNumber: target.order_number })}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Field label={t('queue.driverName')} hint={t('queue.driverHelp')}>
          <Input
            autoFocus
            list="own-delivery-drivers"
            value={driver}
            onChange={(event) => setDriver(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>
        <datalist id="own-delivery-drivers">
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {suggestions.slice(0, 6).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setDriver(name)}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-semibold',
                  driver === name
                    ? 'border-duch-ink bg-duch-ink text-white'
                    : 'border-duch-line bg-white text-stone-600 hover:bg-stone-50',
                )}
              >
                <bdi>{name}</bdi>
              </button>
            ))}
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={busy}>
            {busy ? t('app.loading') : t('queue.sendOut')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
