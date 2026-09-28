-- ---------------------------------------------------------------------------
-- Delivering an order with our own staff, the list the returns screen
-- offers, and closing a "no SKU" sync issue once the SKUs arrive.
--
-- Own delivery. Not every parcel goes with Accurate: sometimes one of the
-- company's own workers takes it. Two steps, mirroring the courier's custody
-- control: the order goes out with a named driver, and only when that driver
-- hands the cash in is it recorded as delivered and paid. Between the two, the
-- packing queue shows who is holding whose money.
--
-- This is the third way an order becomes paid, and it keeps the rule from
-- DECISIONS.md #2 intact: courier cash is only recognised against a courier
-- statement, and money that never went near a courier is settled by a person
-- saying so, with their name on the change. mark_order_paid still refuses a
-- cash-on-delivery order; complete_own_delivery is the only other door, and it
-- only opens for an order that is out with our own driver.
-- ---------------------------------------------------------------------------

alter table public.shipments add column driver_name text;

comment on column public.shipments.driver_name is
  'Who is carrying it, for a delivery by our own staff (courier = ''own''). '
  'Free text: the worker who delivers may not have a CRM login.';

-- --- Step one: out with our driver ------------------------------------------

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

  if v_order.fulfillment_status <> 'packed' then
    raise exception 'Order % is not packed, so it cannot go out yet', v_order.order_number
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

comment on function public.start_own_delivery is
  'Sends a packed order out with one of our own drivers. No stock moves - it '
  'already did when the order was taken.';

revoke execute on function public.start_own_delivery(uuid, text) from public, anon, authenticated;
grant execute on function public.start_own_delivery(uuid, text) to authenticated, service_role;

-- --- Step two: delivered, and the cash is in ---------------------------------

create or replace function public.complete_own_delivery(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_shipment public.shipments;
begin
  -- The same people who can already settle a paying-later order.
  if not (public.is_admin()
          or public.has_any_role('sales', 'stock_manager')
          or public.is_service_request()) then
    raise exception 'Not allowed to record a delivery' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc
   limit 1
   for update;

  -- A second tap is not an error and must not write a second event.
  if v_shipment.courier = 'own' and v_shipment.status = 'delivered' then
    return v_order;
  end if;

  if v_shipment.id is null or v_shipment.courier <> 'own' or v_shipment.status <> 'out_for_delivery' then
    raise exception 'Order % is not out with one of our own drivers', v_order.order_number
      using errcode = 'check_violation';
  end if;

  update public.shipments
     set status = 'delivered', delivered_at = now()
   where id = v_shipment.id;

  -- Cash on delivery is paid now: the driver has handed it in. Any other
  -- method keeps its own status - a paying-later customer still owes it, and
  -- a transfer is still settled from the orders screen when it lands.
  update public.orders
     set fulfillment_status = 'delivered',
         payment_status = case
           when payment_method = 'cod' and payment_status = 'pending'
             then 'paid'::public.payment_status
           else payment_status
         end
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.complete_own_delivery is
  'Records that our own driver delivered the order and, for cash on delivery, '
  'handed the cash in. The status trigger logs both changes with who did it.';

revoke execute on function public.complete_own_delivery(uuid) from public, anon, authenticated;
grant execute on function public.complete_own_delivery(uuid) to authenticated, service_role;

-- --- The packing queue shows who is out with what ----------------------------
--
-- Same columns as before, in the same order, with three appended - which is
-- all create-or-replace allows. The only other change is the where clause:
-- an order out with our own driver stays on the queue until the cash is in.

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
  s.handed_over_at
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

-- --- Courier custody means the courier ---------------------------------------
--
-- An own delivery is out, but not with Accurate: counting it here would mix
-- our drivers into the courier's figures and its seven-to-ten-day overdue
-- thresholds. It is tracked on the packing queue instead.

create or replace view public.v_courier_custody
with (security_invoker = on) as
select
  s.id                 as shipment_id,
  s.tracking_number,
  s.courier,
  s.status,
  s.direction,
  s.handed_over_at,
  s.cod_amount_egp,
  o.id                 as order_id,
  o.order_number,
  c.full_name          as customer_name,
  c.governorate,
  extract(epoch from (now() - s.handed_over_at)) / 86400 as days_in_custody,
  (
    select coalesce(sum(li.quantity), 0)
      from public.order_line_items li where li.order_id = o.id
  )                    as units_out
from public.shipments s
join public.orders o on o.id = s.order_id
left join public.customers c on c.id = o.customer_id
where s.handed_over_at is not null
  and s.courier <> 'own'
  and s.status in ('in_transit', 'out_for_delivery', 'delivery_failed', 'return_in_transit');

-- --- What the returns screen offers when someone taps the box ----------------
--
-- Orders a customer could bring back: delivered in the last 30 days, with no
-- return already open. Parcels the courier is bringing back come from
-- v_returns_inbound, which already exists.

create or replace view public.v_returnable_orders
with (security_invoker = on) as
select
  o.id                                   as order_id,
  o.order_number,
  o.channel,
  c.full_name                            as customer_name,
  c.phone                                as customer_phone,
  coalesce(s.delivered_at, o.created_at) as delivered_at,
  (
    select string_agg(li.sku || ' x' || li.quantity, ', ' order by li.created_at)
      from public.order_line_items li where li.order_id = o.id
  )                                      as items
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sh.delivered_at from public.shipments sh
   where sh.order_id = o.id and sh.direction = 'outbound'
   order by sh.created_at desc
   limit 1
) s on true
where o.fulfillment_status = 'delivered'
  and coalesce(s.delivered_at, o.created_at) > now() - interval '30 days'
  and not exists (
    select 1 from public.returns r where r.order_id = o.id and r.status <> 'closed'
  );

comment on view public.v_returnable_orders is
  'Delivered in the last 30 days with no return open. A shop sale counts from '
  'the moment it was rung up, since that is when it was handed over.';

grant select on public.v_returnable_orders to authenticated;

-- --- A "no SKU" issue closes once the SKUs arrive -----------------------------
--
-- Stock disagreements still wait for a person. This one the CRM can check for
-- itself: the product import and the product webhook call this when every
-- variant of a product came through with a SKU.

create or replace function public.close_sku_issue(p_shopify_product_id bigint)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with closed as (
    update public.sync_issues
       set status          = 'resolved',
           resolved_at     = now(),
           resolution_note = 'Every variant now has a SKU in Shopify'
     where status = 'open'
       and type = 'missing_in_crm'
       and details ->> 'reason' = 'variants_without_sku'
       and details ->> 'shopify_product_id' = p_shopify_product_id::text
    returning 1
  )
  select count(*)::integer from closed;
$$;

revoke execute on function public.close_sku_issue(bigint) from public, anon, authenticated;
grant execute on function public.close_sku_issue(bigint) to service_role;

-- Issues already open whose SKUs have since arrived: the CRM now holds at
-- least as many variants for the product as were missing, all added after
-- the issue was raised.
update public.sync_issues si
   set status          = 'resolved',
       resolved_at     = now(),
       resolution_note = 'Every variant now has a SKU in Shopify'
 where si.status = 'open'
   and si.type = 'missing_in_crm'
   and si.details ->> 'reason' = 'variants_without_sku'
   and (
     select count(*)
       from public.variants v
       join public.products p on p.id = v.product_id
      where p.shopify_product_id::text = si.details ->> 'shopify_product_id'
        and v.created_at > si.detected_at
   ) >= coalesce((si.details ->> 'count')::integer, 1);
