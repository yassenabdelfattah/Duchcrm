-- A shipment number is a pickup booked, not a parcel gone (2026-10-24).
--
-- One-step shipping (2026-10-01) put an order "with the courier" the moment
-- its shipment number was typed. But the number comes when the pickup is
-- booked with Accurate; the parcel sits in the shop until the courier comes
-- for it. #1462 was cancelled by its customer in that gap, and the CRM could
-- not cancel it - "already with the courier, record a return" - nor follow
-- Shopify's cancellation, so its piece stayed out of stock.
--
-- Now (the owner's choices):
--   * Shipping is still one tap: the number, "ship". The order is "waiting for
--     the courier" (awaiting_pickup), its shipment booked but not handed over.
--   * When the courier comes, one tap marks every waiting parcel collected, or
--     each label is scanned as it leaves (mark_picked_up). That is the
--     handover: the order is with the courier and its custody clock starts.
--   * Until then it can be cancelled, here or in Shopify: the piece goes back
--     on the shelf and the booked shipment is cancelled. After, it comes back
--     through returns, as before.
--   * #1462, cancelled in Shopify with its parcel still in the shop, is put
--     back to waiting and cancelled.

create or replace function public.ship_order(p_order_id uuid, p_tracking_number text)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_existing public.shipments;
  v_shipment public.shipments;
  v_tracking text := nullif(trim(p_tracking_number), '');
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not ship orders' using errcode = 'insufficient_privilege';
  end if;

  -- A parcel with no number cannot be chased if it goes missing.
  if v_tracking is null then
    raise exception 'Enter the courier''s shipment number'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null or v_order.fulfillment_status = 'cancelled' then
    raise exception 'Order % is cancelled', v_order.order_number
      using errcode = 'check_violation';
  end if;

  if v_order.fulfillment_status in ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed') then
    -- Booked, not handed over: the parcel is still here. Same amount the
    -- courier collects as before - the goods plus the shipping the customer
    -- agreed to pay; a prepaid order collects nothing.
    insert into public.shipments (
      order_id, tracking_number, direction, status, cod_amount_egp
    )
    values (
      p_order_id, v_tracking, 'outbound', 'awaiting_pickup',
      case when v_order.payment_method = 'cod'
           then v_order.total_egp + v_order.shipping_egp
           else 0 end
    )
    returning * into v_shipment;

  elsif v_order.fulfillment_status = 'awaiting_pickup' then
    -- Already booked and still here: a corrected number replaces the old one.
    select * into v_existing
      from public.shipments
     where order_id = p_order_id and direction = 'outbound' and status <> 'cancelled'
     order by created_at desc
     limit 1
     for update;

    if v_existing.id is null or v_existing.courier = 'own' or v_existing.handed_over_at is not null then
      raise exception 'Order % is already out', v_order.order_number
        using errcode = 'check_violation';
    end if;

    update public.shipments
       set tracking_number = v_tracking,
           status          = 'awaiting_pickup'
     where id = v_existing.id
    returning * into v_shipment;

  else
    raise exception 'Order % is already out (it is %)', v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set fulfillment_status = 'awaiting_pickup'
   where id = p_order_id
     and fulfillment_status <> 'awaiting_pickup';

  return v_shipment;
end;
$$;

-- --- The courier came ---------------------------------------------------------------

-- The handover: these parcels are with the courier from now. Named either by
-- order (the one tap for every waiting parcel - the screen passes the ones it
-- shows) or by the shipment number on a scanned label.
create or replace function public.mark_picked_up(
  p_order_ids uuid[] default null,
  p_tracking  text   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids     uuid[];
  v_numbers text[];
  v_code    text := nullif(trim(p_tracking), '');
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not ship orders' using errcode = 'insufficient_privilege';
  end if;

  if v_code is not null then
    select array_agg(sh.order_id) into v_ids
      from public.shipments sh
      join public.orders o on o.id = sh.order_id
     where sh.tracking_number = v_code
       and sh.direction = 'outbound'
       and sh.status = 'awaiting_pickup'
       and o.fulfillment_status = 'awaiting_pickup';

    if v_ids is null then
      if exists (select 1 from public.shipments where tracking_number = v_code and status <> 'awaiting_pickup') then
        raise exception 'Parcel % is not waiting for the courier', v_code
          using errcode = 'check_violation', hint = 'not_waiting_for_pickup';
      end if;
      raise exception 'No parcel with shipment number %', v_code
        using errcode = 'no_data_found';
    end if;
  else
    select array_agg(o.id) into v_ids
      from public.orders o
     where o.id = any (coalesce(p_order_ids, '{}'))
       and o.fulfillment_status = 'awaiting_pickup';
  end if;

  if v_ids is null then
    return jsonb_build_object('count', 0, 'order_numbers', '[]'::jsonb);
  end if;

  update public.shipments
     set status         = 'in_transit',
         handed_over_at = now()
   where order_id = any (v_ids)
     and direction = 'outbound'
     and status = 'awaiting_pickup';

  -- The status trigger writes each order's history, with who did it.
  update public.orders
     set fulfillment_status = 'in_transit'
   where id = any (v_ids)
     and fulfillment_status = 'awaiting_pickup';

  select array_agg(order_number order by order_number) into v_numbers
    from public.orders where id = any (v_ids);

  return jsonb_build_object('count', cardinality(v_ids), 'order_numbers', to_jsonb(v_numbers));
end;
$$;

revoke execute on function public.mark_picked_up(uuid[], text) from public, anon;
grant execute on function public.mark_picked_up(uuid[], text) to authenticated, service_role;

-- --- Cancelling before the courier comes ------------------------------------------

-- As in 20261024090000, plus the booked shipment called off.
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders;
  v_movements    jsonb := '[]'::jsonb;
  v_line         record;
  v_from_shopify boolean := coalesce(current_setting('duch.from_shopify', true), '') = 'on';
begin
  if not (public.is_admin() or public.has_permission('orders.cancel') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may cancel an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'cancelled' then
    return v_order;
  end if;

  -- An order already with the courier cannot simply be cancelled; it has to
  -- come back first, which is the returns flow rather than this one.
  --
  -- A store sale is exempt. It is created already delivered, because the
  -- customer walked out with it, and voiding one at the counter is an ordinary
  -- thing to need to do.
  if v_order.channel <> 'store'
     and v_order.fulfillment_status in ('in_transit', 'out_for_delivery', 'delivered')
  then
    raise exception 'Order % is already with the courier or delivered. Record a return instead.',
      v_order.order_number
      using errcode = 'check_violation',
            hint = 'use_returns_flow';
  end if;

  -- Refused, on its way back, or back: the goods come back at the returns
  -- check-in, which is where its stock returns. Cancelling as well would put
  -- the same pieces back twice.
  if v_order.fulfillment_status in ('delivery_failed', 'return_in_transit', 'returned') then
    raise exception 'Order % is coming back or already back. Its stock returns when it is checked in.',
      v_order.order_number
      using errcode = 'check_violation',
            hint = 'use_returns_flow';
  end if;

  if v_order.shopify_order_id is not null
     and v_order.payment_status = 'paid'
     and not v_from_shopify
  then
    raise exception 'Order % was paid online. Cancel it in Shopify so the customer is refunded.',
      v_order.order_number
      using errcode = 'check_violation',
            hint = 'cancel_in_shopify';
  end if;

  -- Stock only comes back if it was taken in the first place. A store sale
  -- deducted at the till; an online order deducted when it was created.
  for v_line in
    select li.variant_id, li.quantity
      from public.order_line_items li
      join public.variants v on v.id = li.variant_id
     where li.order_id = p_order_id
       and v.track_inventory
  loop
    v_movements := v_movements || jsonb_build_object(
      'variant_id', v_line.variant_id,
      'quantity_delta', v_line.quantity
    );
  end loop;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'cancellation',
      p_movements       => v_movements,
      p_reference_type  => 'order_cancellation',
      p_reference_id    => v_order.id::text,
      p_note            => p_reason,
      p_idempotency_key => 'cancel:' || v_order.id::text
    );
  end if;

  update public.orders
     set fulfillment_status = 'cancelled',
         cancelled_at       = now(),
         cancelled_by       = auth.uid(),
         cancel_reason      = p_reason
   where id = p_order_id
  returning * into v_order;

  -- A shipment booked but not collected is called off with the order: the
  -- parcel never left. (One already collected cannot reach here.)
  update public.shipments
     set status = 'cancelled'
   where order_id = p_order_id
     and direction = 'outbound'
     and status in ('created', 'awaiting_pickup');

  -- A replacement called off: the old piece is not coming back for it.
  if v_order.exchange_for_order_id is not null then
    update public.returns
       set status = 'closed',
           note   = concat_ws(E'\n', note, 'Exchange cancelled')
     where replacement_order_id = p_order_id
       and type = 'exchange'
       and status in ('expected', 'in_transit');
  end if;

  if v_from_shopify then
    -- Shopify already has it cancelled; an edit still waiting to go out
    -- would only fail against a cancelled order.
    delete from public.shopify_order_outbox where order_id = p_order_id;
  else
    perform public.queue_shopify_order_sync(p_order_id, 'cancel');
  end if;

  return v_order;
end;
$$;

-- --- #1462 ------------------------------------------------------------------------------

-- Cancelled by its customer in Shopify on 2026-10-24 with its parcel still in
-- the shop (the owner, the same day). Back to waiting for the courier, then
-- cancelled as one cancelled in Shopify is: the piece back on the shelf, the
-- booked shipment called off, nothing sent back to Shopify.
do $$
declare
  v_id uuid;
begin
  select id into v_id from public.orders where order_number = '#1462' and fulfillment_status = 'in_transit';
  if v_id is null then
    return;
  end if;

  update public.shipments
     set status = 'awaiting_pickup', handed_over_at = null
   where order_id = v_id and direction = 'outbound' and status = 'in_transit';
  update public.orders set fulfillment_status = 'awaiting_pickup' where id = v_id;

  perform set_config('duch.from_shopify', 'on', true);
  perform public.cancel_order(v_id, 'Cancelled by the customer before the courier collected it');
  perform set_config('duch.from_shopify', '', true);
end;
$$;

-- --- The packing screen knows a website order ---------------------------------------

-- As in 20261021090000, with shopify_order_id on the end, so cancelling a
-- booked parcel from the packing screen says it goes to Shopify too.
create or replace view public.v_packing_queue
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
  s.id                       as shipment_id,
  s.tracking_number,
  s.cod_amount_egp,
  (
    select count(*)
      from public.returns r
      join public.orders o2 on o2.id = r.order_id
     where o2.customer_id = c.id
       and r.type = 'failed_delivery'
  )                          as customer_prior_refusals,
  s.courier,
  s.driver_name,
  s.handed_over_at,
  -- Appended: a replacement, and the old piece the courier collects with it.
  (select x.order_number from public.orders x where x.id = o.exchange_for_order_id)
                             as exchange_for_order_number,
  (select string_agg(rl.sku || ' x' || rl.quantity_expected, ', ' order by rl.created_at)
     from public.returns r
     join public.return_lines rl on rl.return_id = r.id
    where r.replacement_order_id = o.id
      and r.type = 'exchange'
      and r.status in ('expected', 'in_transit'))
                             as exchange_collect_items,
  -- Appended: a website order, so cancelling it also cancels it in Shopify.
  o.shopify_order_id
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sh.* from public.shipments sh
   where sh.order_id = o.id and sh.direction = 'outbound'
   order by sh.created_at desc
   limit 1
) s on true
where (
        o.fulfillment_status in (
          'awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup'
        )
        or (o.fulfillment_status = 'out_for_delivery' and s.courier = 'own')
      )
  and (o.hold_until is null or o.hold_until <= current_date);
