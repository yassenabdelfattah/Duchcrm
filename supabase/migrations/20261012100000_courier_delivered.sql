-- ---------------------------------------------------------------------------
-- "The customer has it": marking a courier parcel delivered by hand.
--
-- The owner's ask (2026-10-12). Nothing moved an Accurate parcel past "in
-- transit" - that was waiting on Accurate's integration - so delivered
-- parcels stayed on the road for ever: never in the owed list, never on the
-- returns list, and late after seven days whatever had really happened.
--
-- This records that the customer received it. The money is a separate fact:
-- a cash-on-delivery parcel stays unpaid, because Accurate still holds the
-- cash until their statement is reviewed (or someone marks it paid). The
-- order moves from "on the road" to "delivered, not paid", which is exactly
-- where it now is.
--
-- Our own drivers have their own step, complete_own_delivery, which records
-- the cash at the same time; this is for a courier's parcels only.
-- ---------------------------------------------------------------------------

create or replace function public.mark_courier_delivered(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_shipment public.shipments;
begin
  if not (public.has_permission('orders.settle')
          or public.has_permission('orders.ship')
          or public.is_service_request()) then
    raise exception 'Not allowed to record a delivery' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  -- A second tap: already delivered, nothing to do.
  if v_order.fulfillment_status = 'delivered' then
    return v_order;
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'Order % is cancelled', v_order.order_number using errcode = 'check_violation';
  end if;

  if v_order.fulfillment_status not in ('in_transit', 'out_for_delivery') then
    raise exception 'Order % is not with the courier', v_order.order_number
      using errcode = 'check_violation';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id
     and direction = 'outbound'
     and status <> 'cancelled'
   order by created_at desc
   limit 1
   for update;

  if v_shipment.id is null or v_shipment.courier = 'own' then
    raise exception 'Order % is not with the courier', v_order.order_number
      using errcode = 'check_violation',
            hint = 'An order with our own driver is completed with the cash, not here.';
  end if;

  update public.shipments
     set status = 'delivered',
         delivered_at = coalesce(delivered_at, now())
   where id = v_shipment.id;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set fulfillment_status = 'delivered'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.mark_courier_delivered(uuid) is
  'Records that the customer received a courier parcel. Leaves the payment '
  'as it is: cash on delivery stays unpaid until the courier pays it.';

revoke execute on function public.mark_courier_delivered(uuid) from public, anon;
grant execute on function public.mark_courier_delivered(uuid) to authenticated, service_role;
