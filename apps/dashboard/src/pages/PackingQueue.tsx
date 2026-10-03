import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { can, formatEGP } from '@duch/shared';
import { useGetIdentity } from '@refinedev/core';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { markQueueSeen, readSeenAt } from '../hooks/useQueueAlert';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
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
 * Waiting to go out. Shipping is one step from any of these: the shipment
 * number, one tap, and the parcel is with the courier.
 */
const TO_SHIP: readonly FulfillmentStatus[] = [
  'awaiting_confirmation',
  'confirmed',
  'ready_to_pack',
  'packed',
  'awaiting_pickup',
];

export function PackingQueue() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  // Sales staff run the confirmation calls; packing staff do the physical
  // work. Showing everyone every button means half the shop taps things the
  // database then refuses, which reads as the app being broken.
  const mayPack = can(identity?.permissions, 'orders.ship');
  // Recording cash as received is settling money, so it follows who may
  // settle a paying-later order - not who packs.
  const maySettle = can(identity?.permissions, 'orders.settle');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Errors belong on the card they are about: with a long list, a message at
  // the top of the page is off screen from the button that caused it.
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [calling, setCalling] = useState<QueueRow | null>(null);
  const [sendingOut, setSendingOut] = useState<QueueRow | null>(null);
  const [slip, setSlip] = useState<SlipOrder | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  // When the packer last looked, read before this visit counts as looking -
  // so what arrived since is marked new on its card.
  const seenBefore = useRef(Date.parse(readSeenAt()));

  const load = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from('v_packing_queue')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(500);

    if (queryError) {
      setError(arabicError(queryError));
      return;
    }
    setError(null);
    setRows((data ?? []) as QueueRow[]);
    // Being on this screen is seeing the queue: the badge on the menu clears.
    markQueueSeen();
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

  const toShip = useMemo(
    () => (rows ?? []).filter((row) => TO_SHIP.includes(row.fulfillment_status)),
    [rows],
  );
  // The view only returns out_for_delivery for our own drivers, so this is
  // cash still to be handed in - never a parcel with Accurate.
  const withOurDriver = useMemo(
    () => (rows ?? []).filter((row) => row.fulfillment_status === 'out_for_delivery'),
    [rows],
  );

  function setCardError(orderId: string, message: string | null) {
    setCardErrors((current) => {
      const next = { ...current };
      if (message) next[orderId] = message;
      else delete next[orderId];
      return next;
    });
  }

  // PromiseLike rather than Promise: supabase.rpc() returns a builder that is
  // thenable but is not an actual Promise.
  async function run(
    row: QueueRow,
    fn: () => PromiseLike<{ error: { code?: string; message: string } | null }>,
  ): Promise<boolean> {
    setBusyId(row.order_id);
    setCardError(row.order_id, null);
    const { error: rpcError } = await fn();
    setBusyId(null);
    if (rpcError) {
      setCardError(row.order_id, describeError(rpcError, t));
      return false;
    }
    await load();
    return true;
  }

  async function ship(row: QueueRow) {
    const code = (tracking[row.order_id] ?? row.tracking_number ?? '').trim();
    if (!code) {
      setCardError(row.order_id, t('queue.shipmentNumberNeeded'));
      return;
    }
    const shipped = await run(row, () =>
      supabase.rpc('ship_order', { p_order_id: row.order_id, p_tracking_number: code }),
    );
    if (shipped) {
      setTracking((current) => {
        const next = { ...current };
        delete next[row.order_id];
        return next;
      });
    }
  }

  if (slip) return <PackingSlip order={slip} onClose={() => setSlip(null)} />;
  if (invoiceId) return <Invoice orderId={invoiceId} onClose={() => setInvoiceId(null)} />;
  if (!rows) return <Spinner label={t('app.loading')} />;

  const isNew = (row: QueueRow) =>
    TO_SHIP.includes(row.fulfillment_status) && Date.parse(row.created_at) > seenBefore.current;

  function renderCard(row: QueueRow) {
    const waiting = TO_SHIP.includes(row.fulfillment_status);
    const busy = busyId === row.order_id;

    return (
            <Card
              key={row.order_id}
              className={cx('space-y-3', isNew(row) && 'ring-2 ring-duch-accent')}
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular text-sm font-extrabold">{row.order_number}</span>
                    {isNew(row) ? <Badge tone="bad">{t('queue.new')}</Badge> : null}
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

              {/* The one step: the courier's number, then ship. Enter works
                  too, so a scanner that ends with Enter ships on the scan. */}
              {mayPack && waiting ? (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void ship(row);
                  }}
                >
                  <Input
                    dir="ltr"
                    className="tabular min-w-0 flex-1"
                    placeholder={t('queue.shipmentNumber')}
                    aria-label={t('queue.shipmentNumber')}
                    autoComplete="off"
                    value={tracking[row.order_id] ?? row.tracking_number ?? ''}
                    onChange={(event) =>
                      setTracking((current) => ({ ...current, [row.order_id]: event.target.value }))
                    }
                    disabled={busy}
                  />
                  <Button type="submit" disabled={busy}>
                    {busy ? t('app.loading') : t('queue.ship')}
                  </Button>
                </form>
              ) : null}

              {cardErrors[row.order_id] ? <ErrorNote>{cardErrors[row.order_id]}</ErrorNote> : null}

              <div className="flex flex-wrap gap-2 border-t border-duch-line pt-3">
                {mayPack && waiting ? (
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3 text-xs"
                    onClick={() => setSendingOut(row)}
                    disabled={busy}
                  >
                    {t('queue.deliverOurselves')}
                  </Button>
                ) : null}

                {/* Optional: logging the call, or a customer cancelling on
                    it. Nothing waits on it any more. */}
                {row.fulfillment_status === 'awaiting_confirmation' ? (
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3 text-xs"
                    onClick={() => setCalling(row)}
                    disabled={busy}
                  >
                    {t('queue.call')}
                  </Button>
                ) : null}

                {maySettle && row.fulfillment_status === 'out_for_delivery' ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(row, () =>
                        supabase.rpc('complete_own_delivery', { p_order_id: row.order_id }),
                      )
                    }
                  >
                    {row.payment_method === 'cod' ? t('queue.cashReceived') : t('queue.delivered')}
                  </Button>
                ) : null}

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
        <span className="tabular rounded-full bg-duch-ink px-2 py-0.5 text-xs font-semibold text-white">
          {toShip.length}
        </span>
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

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {toShip.length === 0 ? (
        <EmptyState title={t('queue.empty')} />
      ) : (
        <div className="space-y-3">{toShip.map(renderCard)}</div>
      )}

      {/* Out with our own driver, cash not handed in yet. Not a packing step -
          it is here so the money in a driver's pocket is not forgotten. */}
      {withOurDriver.length > 0 ? (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 border-b border-duch-line pb-2 text-sm font-extrabold">
            {t('queue.withOurDriver')}
            <span className="tabular rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold">
              {withOurDriver.length}
            </span>
          </h2>
          {withOurDriver.map(renderCard)}
        </section>
      ) : null}

      <CallDialog
        row={calling}
        onClose={() => setCalling(null)}
        onDone={() => {
          setCalling(null);
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
  // The courier's numbers are unique; a repeat is almost always a label
  // scanned twice, or the wrong parcel's label.
  if (error.code === '23505') return t('queue.shipmentNumberTaken');
  return arabicError(error);
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
