-- The Orders screen, organised like Shopify's (2026-10-23).
--
-- Two columns appended to v_order_list (a view can only grow at the end):
--
--   is_closed - nothing left to do on the order, so it moves to the archive
--     tab by itself: cancelled; delivered and paid, with no difference owed
--     back from an exchange; or returned with the parcel checked in. Any
--     return still expected or short keeps it in the open lists. Recomputed
--     on every read, so an order reopened (a payment reopened by the owner, a
--     return started) comes back out on its own.
--   customer_governorate - for the governorate filter.
--
-- Archived orders - the ones that should never have been in the CRM
-- (20261022090000) - stay out entirely, as before.

create or replace view public.v_order_list
with (security_invoker = on) as
select
  o.id,
  o.order_number,
  o.channel,
  o.created_at,
  o.fulfillment_status,
  o.payment_status,
  o.payment_method,
  o.subtotal_egp,
  o.discount_egp,
  o.shipping_egp,
  o.total_egp,
  o.cancelled_at,
  o.note,
  o.customer_id,
  c.full_name                as customer_name,
  c.phone                    as customer_phone,
  nullif(
    concat_ws('، ',
      nullif(trim(c.address_line1), ''),
      nullif(trim(c.address_line2), ''),
      nullif(trim(c.city), ''),
      nullif(trim(c.governorate), '')
    ),
    ''
  )                          as customer_address,
  -- The parcel as it stands: the latest outbound shipment that was not
  -- called off. A shipment cancelled because the order went with our own
  -- driver instead is history, not where the order is.
  s.id                       as shipment_id,
  s.tracking_number,
  s.courier,
  s.driver_name,
  s.status                   as shipment_status,
  s.handed_over_at,
  s.delivered_at,
  s.cod_amount_egp,
  coalesce(li.lines, '[]'::jsonb) as items,
  coalesce(li.unit_count, 0)      as unit_count,
  -- Which list the order belongs in. The screen's tabs are these.
  case
    when o.cancelled_at is not null or o.fulfillment_status = 'cancelled' then 'cancelled'
    when o.fulfillment_status in
         ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup')
      then 'to_ship'
    when o.fulfillment_status in ('in_transit', 'out_for_delivery') then 'on_the_road'
    when o.fulfillment_status = 'delivered' then 'delivered'
    else 'back'
  end                        as stage,
  -- Since when it has been where it is. A parcel on the road counts from
  -- the handover - the same clock as the courier custody report. Otherwise
  -- the moment it reached its current status, from the history; an order
  -- that has never moved has been there since it was created.
  coalesce(
    case when o.fulfillment_status in ('in_transit', 'out_for_delivery') then s.handed_over_at end,
    (select max(e.created_at)
       from public.order_events e
      where e.order_id = o.id
        and e.to_fulfillment = o.fulfillment_status),
    o.created_at
  )                          as stage_since,
  -- Appended (a view can only grow at the end): whether the order came from
  -- Shopify, and whether a change made here is still on its way there.
  o.shopify_order_id,
  exists (
    select 1 from public.shopify_order_outbox q where q.order_id = o.id
  )                          as shopify_pending,
  -- Appended for exchanges: on a replacement, what it replaced and any
  -- difference owed back; on an original, the replacements made for it.
  o.exchange_for_order_id,
  (select x.order_number from public.orders x where x.id = o.exchange_for_order_id)
                             as exchange_for_order_number,
  o.exchange_refund_egp,
  o.exchange_refunded_at,
  (select string_agg(x.order_number, '، ' order by x.created_at)
     from public.orders x
    where x.exchange_for_order_id = o.id and x.cancelled_at is null)
                             as exchanged_in,
  -- Appended for the archive tab: nothing left to do on it. Cancelled; or
  -- delivered with the money in and nothing owed back; or returned with
  -- the parcel checked in. A return still on its way keeps it open either way.
  (
    o.cancelled_at is not null
    or o.fulfillment_status = 'cancelled'
    or (
      o.fulfillment_status in ('delivered', 'returned')
      and (o.fulfillment_status = 'returned'
           or o.payment_status in ('paid', 'refunded', 'partially_refunded'))
      and not (o.exchange_refund_egp > 0 and o.exchange_refunded_at is null)
      and not exists (
        select 1 from public.returns r
         where r.order_id = o.id
           and r.status in ('expected', 'in_transit', 'discrepancy')
      )
    )
  )                          as is_closed,
  c.governorate              as customer_governorate
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sh.*
    from public.shipments sh
   where sh.order_id = o.id
     and sh.direction = 'outbound'
     and sh.status <> 'cancelled'
   order by sh.created_at desc
   limit 1
) s on true
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'sku', l.sku,
        'title', l.title,
        'variant_title', l.variant_title,
        'quantity', l.quantity,
        'unit_price_egp', l.unit_price_egp,
        'total_egp', l.total_egp
      )
      order by l.created_at
    )                    as lines,
    sum(l.quantity)::int as unit_count
  from public.order_line_items l
  where l.order_id = o.id
) li on true
where o.archived_at is null;
