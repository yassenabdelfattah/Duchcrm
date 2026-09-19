-- ---------------------------------------------------------------------------
-- Phase 3: checking returns back in.
--
-- Returns do not arrive one at a time. The pickup car brings back whatever has
-- accumulated at the courier's station, so this is a batch job: a pile of
-- parcels on a table, each with a code on it, worked through one by one.
--
-- The design follows from that. Everything starts from scanning the code on
-- the parcel, and the scan alone works out what needs to happen - whether the
-- failure has already been recorded or is being discovered right now, on the
-- table, because nobody entered it when the courier phoned.
-- ---------------------------------------------------------------------------

-- --- What should be coming back --------------------------------------------

create or replace view public.v_returns_inbound
with (security_invoker = on) as
select
  r.id                  as return_id,
  r.type,
  r.reason,
  r.status,
  r.courier_reported_at,
  o.id                  as order_id,
  o.order_number,
  o.payment_method,
  c.full_name           as customer_name,
  c.phone               as customer_phone,
  c.governorate,
  s.tracking_number,
  extract(epoch from (now() - coalesce(r.courier_reported_at, r.created_at))) / 86400
                        as days_since_reported,
  (
    select coalesce(sum(rl.quantity_expected), 0)
      from public.return_lines rl where rl.return_id = r.id
  )                     as units_expected,
  (
    select string_agg(rl.sku || ' x' || rl.quantity_expected, ', ' order by rl.created_at)
      from public.return_lines rl where rl.return_id = r.id
  )                     as items
from public.returns r
join public.orders o on o.id = r.order_id
left join public.customers c on c.id = o.customer_id
left join public.shipments s on s.id = r.outbound_shipment_id
where r.status in ('expected', 'in_transit');

comment on view public.v_returns_inbound is
  'Parcels the courier owes us back. A row here that is older than the two or '
  'three days a return normally takes is the thing worth a phone call.';

grant select on public.v_returns_inbound to authenticated;

-- --- One scan, whatever state it is in -------------------------------------

create or replace function public.lookup_return_by_tracking(p_tracking text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_return   public.returns;
  v_customer public.customers;
  v_lines    jsonb;
begin
  if public.auth_role() is null and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('state', 'not_found', 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  select * into v_return
    from public.returns
   where outbound_shipment_id = v_shipment.id
   order by created_at desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'return_line_id', rl.id,
           'sku', rl.sku,
           'variant_id', rl.variant_id,
           'title', li.title,
           'variant_title', li.variant_title,
           'quantity_expected', rl.quantity_expected,
           'quantity_received', rl.quantity_received,
           'quantity_resellable', rl.quantity_resellable,
           'quantity_damaged', rl.quantity_damaged
         ) order by rl.created_at), '[]'::jsonb)
    into v_lines
    from public.return_lines rl
    left join public.order_line_items li on li.id = rl.order_line_item_id
   where rl.return_id = v_return.id;

  return jsonb_build_object(
    'state', case
      -- Fully accounted for. Scanning it again says so rather than inviting a
      -- second count of the same parcel.
      when v_return.id is not null and v_return.status in ('received', 'closed')
        then 'already_received'
      -- A return still marked short stays open on purpose: the missing piece
      -- may turn up next week, and it should be recordable when it does.
      -- receive_return only ever moves the difference, so scanning a short
      -- parcel again cannot add the same garments to stock twice.
      when v_return.id is not null then 'ready_to_receive'
      -- The parcel is on the table but nobody recorded the failure when the
      -- courier rang. Rather than making someone go and do that first, the
      -- screen offers to record it and check it in as one action.
      when v_order.fulfillment_status in ('in_transit', 'out_for_delivery',
                                          'delivery_failed', 'return_in_transit')
        then 'needs_failure_record'
      else 'not_returnable'
    end,
    'tracking_number', v_shipment.tracking_number,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'fulfillment_status', v_order.fulfillment_status,
      'payment_method', v_order.payment_method,
      'total_egp', v_order.total_egp,
      'customer_name', v_customer.full_name,
      'customer_phone', v_customer.phone,
      'governorate', v_customer.governorate
    ),
    'return', case
      when v_return.id is null then null
      else jsonb_build_object(
        'id', v_return.id,
        'type', v_return.type,
        'reason', v_return.reason,
        'status', v_return.status
      )
    end,
    'lines', v_lines,
    -- What went out, for the case where no return exists yet and the screen
    -- has to show the packer what to expect in the parcel.
    'order_lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'order_line_item_id', li.id,
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       where li.order_id = v_order.id
    )
  );
end;
$$;

comment on function public.lookup_return_by_tracking is
  'Everything the check-in screen needs from one scan of the courier code, '
  'including whether the failure still has to be recorded first.';

revoke execute on function public.lookup_return_by_tracking(text) from public, anon;
grant execute on function public.lookup_return_by_tracking(text) to authenticated, service_role;

-- --- Recording the failure from the parcel in your hand --------------------
--
-- record_delivery_failure() takes an order id. This takes the code printed on
-- the parcel, which is what the person actually has.

create or replace function public.record_delivery_failure_by_tracking(
  p_tracking text,
  p_reason   public.return_reason,
  p_note     text default null
)
returns public.returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
begin
  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    raise exception 'No shipment with tracking code %', p_tracking
      using errcode = 'no_data_found';
  end if;

  return public.record_delivery_failure(v_shipment.order_id, p_reason, p_note);
end;
$$;

revoke execute on function public.record_delivery_failure_by_tracking(text, public.return_reason, text) from public, anon;
grant execute on function public.record_delivery_failure_by_tracking(text, public.return_reason, text) to authenticated, service_role;

-- --- What today's check-in session actually put back ------------------------

create or replace view public.v_return_checkin_summary
with (security_invoker = on) as
select
  (r.received_at at time zone 'Africa/Cairo')::date as received_date,
  count(distinct r.id)                              as parcels,
  coalesce(sum(rl.quantity_resellable), 0)          as units_back_in_stock,
  coalesce(sum(rl.quantity_damaged), 0)             as units_damaged,
  coalesce(sum(rl.quantity_missing), 0)             as units_missing
from public.returns r
join public.return_lines rl on rl.return_id = r.id
where r.received_at is not null
group by 1;

comment on view public.v_return_checkin_summary is
  'A day of check-ins in one line. The missing column is the one to look at.';

grant select on public.v_return_checkin_summary to authenticated;

-- --- Checking in twice ------------------------------------------------------
--
-- A parcel that arrived short stays open, which means it can legitimately be
-- scanned again later when the missing piece turns up. The original version
-- recorded a movement for the whole resellable quantity every time it ran, so
-- a second check-in would have added the same garments to stock twice.
--
-- This version records only the difference between what was counted before and
-- what is being counted now. Submitting the same numbers twice moves nothing;
-- finding one more piece next week moves exactly one.

create or replace function public.receive_return(
  p_return_id uuid,
  p_lines     jsonb,
  p_note      text default null
)
returns public.returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_return     public.returns;
  v_order      public.orders;
  v_item       jsonb;
  v_line       public.return_lines;
  v_resellable integer;
  v_damaged    integer;
  v_delta      integer;
  v_movements  jsonb := '[]'::jsonb;
  v_missing    integer := 0;
  v_total_back integer := 0;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not check in a return' using errcode = 'insufficient_privilege';
  end if;

  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'Return % not found', p_return_id using errcode = 'no_data_found';
  end if;

  -- Closed means somebody decided it was finished, shortfall and all.
  if v_return.status = 'closed' then
    return v_return;
  end if;

  select * into v_order from public.orders where id = v_return.order_id;

  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_line
      from public.return_lines
     where id = (v_item ->> 'return_line_id')::uuid
       and return_id = p_return_id;

    if not found then
      raise exception 'Return line % does not belong to return %',
        v_item ->> 'return_line_id', p_return_id
        using errcode = 'foreign_key_violation';
    end if;

    v_resellable := coalesce((v_item ->> 'quantity_resellable')::integer, 0);
    v_damaged    := coalesce((v_item ->> 'quantity_damaged')::integer, 0);

    -- Only the change since last time. This is what makes a second check-in
    -- safe rather than a way to invent stock.
    v_delta := v_resellable - v_line.quantity_resellable;

    update public.return_lines
       set quantity_received   = v_resellable + v_damaged,
           quantity_resellable = v_resellable,
           quantity_damaged    = v_damaged,
           condition_note      = coalesce(v_item ->> 'condition_note', condition_note)
     where id = v_line.id;

    if v_delta <> 0 then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_line.variant_id,
        'quantity_delta', v_delta
      );
    end if;
  end loop;

  select coalesce(sum(quantity_missing), 0), coalesce(sum(quantity_resellable), 0)
    into v_missing, v_total_back
    from public.return_lines where return_id = p_return_id;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'return',
      p_movements       => v_movements,
      p_reference_type  => 'return',
      p_reference_id    => p_return_id::text,
      p_note            => p_note,
      -- Keyed on the running total rather than the return alone, so a
      -- double-tapped confirm does nothing while a genuine correction applies.
      p_idempotency_key => 'return:' || p_return_id::text || ':' || v_total_back::text
    );
  end if;

  update public.returns
     set status      = case when v_missing > 0 then 'discrepancy'::public.return_status
                            else 'received'::public.return_status end,
         received_at = coalesce(received_at, now()),
         received_by = coalesce(received_by, auth.uid()),
         note        = coalesce(p_note, note)
   where id = p_return_id
  returning * into v_return;

  update public.orders
     set fulfillment_status = 'returned'
   where id = v_return.order_id
     and fulfillment_status <> 'returned';

  if v_return.outbound_shipment_id is not null then
    update public.shipments
       set status = 'returned', returned_at = coalesce(returned_at, now())
     where id = v_return.outbound_shipment_id;
  end if;

  return v_return;
end;
$$;

revoke execute on function public.receive_return(uuid, jsonb, text) from public, anon;
grant execute on function public.receive_return(uuid, jsonb, text) to authenticated, service_role;
