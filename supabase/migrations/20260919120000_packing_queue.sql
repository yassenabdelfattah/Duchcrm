-- ---------------------------------------------------------------------------
-- Phase 3: the morning queue.
--
-- One screen covering the whole path from a new order to a parcel in the
-- courier's van, because in a shop this size the same person often does all of
-- it. Each stage has exactly one action that moves an order forward, and every
-- one of them goes through a function rather than a direct update, so the
-- transition is checked and recorded rather than merely applied.
-- ---------------------------------------------------------------------------

-- --- The confirmation call -------------------------------------------------

create or replace function public.record_confirmation_call(
  p_order_id   uuid,
  p_outcome    public.confirmation_outcome,
  p_note       text default null,
  p_hold_until date default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  -- Anyone in the office makes these calls, so this is open to every active
  -- staff member rather than to one role.
  if public.auth_role() is null and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status not in ('awaiting_confirmation', 'confirmed') then
    raise exception 'Order % has moved past confirmation (it is %)',
      v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  -- The customer does not want it after all. Cancelling here rather than
  -- shipping and having it refused is the entire point of ringing first: it
  -- saves a courier run out and another one back.
  if p_outcome = 'cancelled_by_customer' then
    update public.orders
       set confirmation_outcome  = p_outcome,
           confirmation_attempts = confirmation_attempts + 1
     where id = p_order_id;

    return public.cancel_order(
      p_order_id,
      coalesce(p_note, 'Customer cancelled on the confirmation call')
    );
  end if;

  update public.orders
     set confirmation_outcome  = p_outcome,
         confirmation_attempts = confirmation_attempts + 1,
         confirmed_at          = case when p_outcome = 'confirmed' then now() else confirmed_at end,
         confirmed_by          = case when p_outcome = 'confirmed' then auth.uid() else confirmed_by end,
         -- Asked to receive it later. Drops out of the queue until that date
         -- rather than sitting there looking neglected.
         hold_until            = case
                                   when p_outcome = 'asked_to_delay' then p_hold_until
                                   else hold_until
                                 end,
         fulfillment_status    = case
                                   when p_outcome = 'confirmed'
                                     then 'ready_to_pack'::public.fulfillment_status
                                   else fulfillment_status
                                 end,
         note                  = case
                                   when p_note is null then note
                                   else coalesce(note || E'\n', '') || p_note
                                 end
   where id = p_order_id
  returning * into v_order;

  -- Unreachable is not a failure on the first try; it is a failure on the
  -- fourth. Recording the attempt is what makes that visible.
  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    p_order_id, 'confirmation_call', p_note,
    jsonb_build_object('outcome', p_outcome, 'attempt', v_order.confirmation_attempts),
    auth.uid()
  );

  return v_order;
end;
$$;

comment on function public.record_confirmation_call is
  'Records the outcome of ringing the customer before dispatch. Confirming '
  'moves the order into the packing queue; a cancellation here saves two '
  'courier runs.';

-- --- Packing ---------------------------------------------------------------

create or replace function public.mark_order_packed(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not pack orders' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'packed' then
    return v_order;
  end if;

  if v_order.fulfillment_status not in ('confirmed', 'ready_to_pack') then
    raise exception 'Order % is not ready to pack (it is %)',
      v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  update public.orders
     set fulfillment_status = 'packed'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

-- --- Back a step -----------------------------------------------------------
--
-- Packers make mistakes. Without this the only way out of a wrong tap is an
-- admin editing the table by hand, which is exactly the habit this system
-- exists to end.

create or replace function public.unpack_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not change a packed order' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status <> 'packed' then
    raise exception 'Only a packed order can be put back (this one is %)',
      v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  update public.orders
     set fulfillment_status = 'ready_to_pack',
         note = case
                  when p_reason is null then note
                  else coalesce(note || E'\n', '') || p_reason
                end
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

-- --- The queue itself ------------------------------------------------------
--
-- Rebuilt to carry the shipment through to handover, so the whole morning is
-- one list rather than a screen per stage.

drop view if exists public.v_packing_queue;

create view public.v_packing_queue
with (security_invoker = on) as
select
  o.id                       as order_id,
  o.order_number,
  o.channel,
  o.fulfillment_status,
  o.payment_status,
  o.payment_method,
  o.total_egp,
  o.shipping_egp,
  o.note,
  o.created_at,
  o.hold_until,
  o.confirmation_outcome,
  o.confirmation_attempts,
  c.id                       as customer_id,
  c.full_name                as customer_name,
  c.phone                    as customer_phone,
  c.address_line1,
  c.city,
  c.governorate,
  c.requires_prepayment,
  extract(epoch from (now() - o.created_at)) / 3600      as age_hours,
  (
    select coalesce(sum(li.quantity), 0)
      from public.order_line_items li where li.order_id = o.id
  )                          as unit_count,
  (
    select string_agg(li.sku || ' x' || li.quantity, ', ' order by li.created_at)
      from public.order_line_items li where li.order_id = o.id
  )                          as items,
  -- The courier's code, once a shipment exists. Null until then, which is what
  -- the screen keys the "create shipment" step off.
  s.id                       as shipment_id,
  s.tracking_number,
  s.cod_amount_egp,
  -- Prior refusals by this customer. Shown next to the order so the decision
  -- about someone who has done it twice is made before a courier run is paid
  -- for, rather than after.
  (
    select count(*)
      from public.returns r
      join public.orders o2 on o2.id = r.order_id
     where o2.customer_id = c.id
       and r.type = 'failed_delivery'
  )                          as customer_prior_refusals
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sh.* from public.shipments sh
   where sh.order_id = o.id and sh.direction = 'outbound'
   order by sh.created_at desc
   limit 1
) s on true
where o.fulfillment_status in (
        'awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup'
      )
  and (o.hold_until is null or o.hold_until <= current_date);

comment on view public.v_packing_queue is
  'Everything waiting on someone in the office, from a new order through to a '
  'parcel ready for the pickup car. Orders the customer asked us to hold drop '
  'out until their date arrives.';

grant select on public.v_packing_queue to authenticated;

-- --- Live updates ----------------------------------------------------------
--
-- The person running this has the CRM open all day. New orders should appear
-- without them refreshing, which is what the publication below enables. Row
-- Level Security still applies to what each person receives.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'orders'
    ) then
      alter publication supabase_realtime add table public.orders;
    end if;
  end if;
end
$$;

revoke execute on function public.record_confirmation_call(uuid, public.confirmation_outcome, text, date) from public, anon;
grant execute on function public.record_confirmation_call(uuid, public.confirmation_outcome, text, date) to authenticated, service_role;

revoke execute on function public.mark_order_packed(uuid) from public, anon;
grant execute on function public.mark_order_packed(uuid) to authenticated, service_role;

revoke execute on function public.unpack_order(uuid, text) from public, anon;
grant execute on function public.unpack_order(uuid, text) to authenticated, service_role;
