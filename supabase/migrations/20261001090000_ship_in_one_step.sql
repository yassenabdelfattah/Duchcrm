-- ---------------------------------------------------------------------------
-- Shipping in one step.
--
-- The owner's call, after the first days live: the packing queue took four
-- taps per parcel - confirm the call, mark packed, enter the shipment number,
-- mark handed to the courier - and every one of them was being done in a
-- row at the moment the parcel left. So it is now one: type (or scan) the
-- courier's shipment number and ship. The order goes straight to the courier
-- - in transit, custody clock started - from wherever it was waiting.
--
-- The confirmation call stays available but is no longer required. Sending
-- with our own driver likewise works from any waiting order, not only a
-- packed one.
--
-- The old step-by-step functions are left in place; nothing calls them from
-- the dashboard any more.
-- ---------------------------------------------------------------------------

create or replace function public.ship_order(
  p_order_id        uuid,
  p_tracking_number text
)
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
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
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
    -- Same amount the courier collects as before: the goods plus the
    -- shipping the customer agreed to pay. A prepaid order collects nothing.
    insert into public.shipments (
      order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at
    )
    values (
      p_order_id, v_tracking, 'outbound', 'in_transit',
      case when v_order.payment_method = 'cod'
           then v_order.total_egp + v_order.shipping_egp
           else 0 end,
      now()
    )
    returning * into v_shipment;

  elsif v_order.fulfillment_status = 'awaiting_pickup' then
    -- Created the old way and still waiting for the courier: send that
    -- shipment, with the number just entered.
    select * into v_existing
      from public.shipments
     where order_id = p_order_id and direction = 'outbound'
     order by created_at desc
     limit 1
     for update;

    if v_existing.id is null or v_existing.courier = 'own' or v_existing.handed_over_at is not null then
      raise exception 'Order % is already out', v_order.order_number
        using errcode = 'check_violation';
    end if;

    update public.shipments
       set tracking_number = v_tracking,
           status          = 'in_transit',
           handed_over_at  = now()
     where id = v_existing.id
    returning * into v_shipment;

  else
    raise exception 'Order % is already out (it is %)', v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set fulfillment_status = 'in_transit'
   where id = p_order_id;

  return v_shipment;
end;
$$;

comment on function public.ship_order(uuid, text) is
  'Hands an order to the courier in one step: records the shipment number and '
  'marks it in transit, from any status still waiting in the packing queue.';

revoke execute on function public.ship_order(uuid, text) from public, anon;
grant execute on function public.ship_order(uuid, text) to authenticated, service_role;

-- --- Our own driver, also from any waiting order ----------------------------

create or replace function public.start_own_delivery(
  p_order_id    uuid,
  p_driver_name text
)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_existing public.shipments;
  v_shipment public.shipments;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not send an order out' using errcode = 'insufficient_privilege';
  end if;

  if nullif(trim(p_driver_name), '') is null then
    raise exception 'Say who is delivering it' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null or v_order.fulfillment_status = 'cancelled' then
    raise exception 'Order % is cancelled', v_order.order_number
      using errcode = 'check_violation';
  end if;

  select * into v_existing
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc
   limit 1
   for update;

  if v_order.fulfillment_status = 'awaiting_pickup'
     and v_existing.id is not null
     and v_existing.courier <> 'own'
     and v_existing.handed_over_at is null then
    -- Created for the courier but never collected: switch it to our driver.
    update public.shipments
       set status = 'cancelled',
           note = coalesce(note || ' ', '') || '[Went with our own driver instead]'
     where id = v_existing.id;
  elsif v_order.fulfillment_status not in ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed') then
    raise exception 'Order % is already out, or the courier already has it', v_order.order_number
      using errcode = 'check_violation';
  end if;

  -- Same amount a courier would collect: the goods plus the shipping the
  -- customer agreed to pay. A prepaid order collects nothing.
  insert into public.shipments (
    order_id, courier, driver_name, direction, status, cod_amount_egp, handed_over_at
  )
  values (
    p_order_id, 'own', trim(p_driver_name), 'outbound', 'out_for_delivery',
    case when v_order.payment_method = 'cod'
         then v_order.total_egp + v_order.shipping_egp
         else 0 end,
    now()
  )
  returning * into v_shipment;

  update public.orders
     set fulfillment_status = 'out_for_delivery'
   where id = p_order_id;

  return v_shipment;
end;
$$;
