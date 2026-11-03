-- Taking back "delivered" when it was pressed by mistake (2026-11-04).
--
-- #1472 was marked delivered on 2026-11-01 while it was still with Accurate,
-- and Accurate's statement has it coming back. There was no way back: the
-- order sat in "delivered, not paid", owed by the courier, and the returns
-- screen would take it only as a return after delivery.
--
-- undo_delivered puts the order and its shipment back where they were before
-- - with the courier, or out with our driver - and records who did it and
-- why. It is for a status pressed by mistake, so it stops where something
-- has been built on the delivery:
--  * the order was paid with the delivery or after it - our driver's "cash
--    received", or the courier's cash marked paid. The owner reopens the
--    payment first (reopen_order_payment). Paid online before it left is not
--    the delivery's doing, and does not stop it;
--  * a piece came back on it, or the old piece of an exchange was collected
--    against it - the return is the record now;
--  * the courier's statement says the customer has it.
-- A statement that says it came back, as #1472's does, is the reason to undo
-- it, so that one does not stop it.
--
-- The people who can mark a courier parcel delivered can take it back: the
-- mistake is the same size either way, and the order's history keeps both.

create or replace function public.undo_delivered(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders;
  v_shipment     public.shipments;
  v_back         public.fulfillment_status;
  v_delivered_at timestamptz;
begin
  if not (public.has_permission('orders.settle')
          or public.has_permission('orders.ship')
          or public.is_service_request()) then
    raise exception 'Not allowed to change a delivery' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status <> 'delivered' or v_order.cancelled_at is not null then
    raise exception 'Order % is not delivered', v_order.order_number
      using errcode = 'check_violation', hint = 'not_delivered';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id
     and direction = 'outbound'
     and status <> 'cancelled'
   order by created_at desc
   limit 1
   for update;

  -- Sold over the counter: handed over as it was rung up, nothing to undo.
  if v_shipment.id is null then
    raise exception 'Order % was never sent out', v_order.order_number
      using errcode = 'check_violation', hint = 'not_shipped';
  end if;

  -- When it was marked delivered, and from where: the step the history
  -- recorded, or where a parcel of this kind waits - out with our driver, or
  -- with the courier.
  select e.created_at, e.from_fulfillment into v_delivered_at, v_back
    from public.order_events e
   where e.order_id = p_order_id
     and e.event_type = 'fulfillment_change'
     and e.to_fulfillment = 'delivered'
   order by e.created_at desc
   limit 1;

  -- Unknown, any payment recorded on it counts as after.
  v_delivered_at := coalesce(v_delivered_at, v_shipment.delivered_at, '-infinity');
  if v_back is null or v_back not in ('in_transit', 'out_for_delivery') then
    v_back := case when v_shipment.courier = 'own' then 'out_for_delivery' else 'in_transit' end;
  end if;

  if v_order.payment_status <> 'pending'
     and exists (select 1 from public.order_events e
                  where e.order_id = p_order_id
                    and e.event_type = 'payment_change'
                    and e.to_payment = 'paid'
                    and e.created_at >= v_delivered_at)
  then
    raise exception 'Order % was paid on delivery: reopen its payment first', v_order.order_number
      using errcode = 'check_violation', hint = 'order_paid';
  end if;

  if exists (select 1 from public.returns r where r.order_id = p_order_id)
     or exists (select 1 from public.returns r
                 where r.replacement_order_id = p_order_id
                   and r.status not in ('expected', 'in_transit'))
  then
    raise exception 'Order % has pieces back from the customer', v_order.order_number
      using errcode = 'check_violation', hint = 'order_has_returns';
  end if;

  if exists (select 1 from public.settlement_lines sl
              where sl.order_id = p_order_id and sl.outcome = 'delivered') then
    raise exception 'The courier''s statement says order % was delivered', v_order.order_number
      using errcode = 'check_violation', hint = 'statement_says_delivered';
  end if;

  update public.shipments
     set status       = v_back::text::public.shipment_status,
         delivered_at = null
   where id = v_shipment.id;

  -- The status trigger records the step back, with who did it.
  update public.orders
     set fulfillment_status = v_back
   where id = p_order_id
  returning * into v_order;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (p_order_id, 'delivery_undone', nullif(btrim(p_reason), ''),
          jsonb_build_object('back_to', v_back, 'tracking_number', v_shipment.tracking_number),
          auth.uid());

  return v_order;
end;
$$;

comment on function public.undo_delivered(uuid, text) is
  'Takes back a delivery recorded by mistake: the order and its shipment go '
  'back to the courier or driver. Refused once paid, once anything came back '
  'on it, or when the courier''s statement says it was delivered.';

revoke execute on function public.undo_delivered(uuid, text) from public, anon;
grant execute on function public.undo_delivered(uuid, text) to authenticated, service_role;
