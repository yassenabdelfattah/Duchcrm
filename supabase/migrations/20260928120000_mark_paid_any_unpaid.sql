-- ---------------------------------------------------------------------------
-- Mark paid, for any unpaid order; and switching a parcel to our own driver
-- before the courier collects it.
--
-- The owner's call, made on go-live week: any order that has not been paid
-- can be marked paid by hand, whatever its payment method - cash on
-- delivery included. Until now cash on delivery could only become paid
-- through a reviewed courier statement or our own driver handing the cash
-- in. That rule protected against recognising money before it was counted;
-- the owner has decided a person saying so, with their name on it, is
-- enough. Every change is still logged by the status trigger with who did
-- it, and the settlement review only pays orders that are still unpaid, so
-- an order already marked paid by hand is skipped rather than counted twice.
--
-- Own delivery could only start from a packed order. But an Accurate shipment
-- is sometimes created and then the parcel goes with our own driver instead.
-- As long as the courier has not collected it, the Accurate shipment is
-- cancelled and the order goes out with our driver as usual.
-- ---------------------------------------------------------------------------

create or replace function public.mark_order_paid(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.orders;
begin
  if not (public.is_admin()
          or public.has_any_role('sales', 'stock_manager')
          or public.is_service_request()) then
    raise exception 'Not allowed to settle an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'Unknown order %', p_order_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: tapping twice is not an error, and the second tap must not
  -- write a second payment event.
  if v_order.payment_status = 'paid' then
    return v_order;
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'A cancelled order cannot be marked paid'
      using errcode = 'check_violation';
  end if;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set payment_status = 'paid'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.mark_order_paid(uuid) is
  'Marks an unpaid order paid, whatever its payment method, with the name of '
  'whoever did it. The courier settlement review skips an order already paid.';

-- --- Own delivery, also from a parcel the courier has not collected ---------

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
  elsif v_order.fulfillment_status <> 'packed' then
    raise exception 'Order % is not packed, or the courier already has it', v_order.order_number
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
