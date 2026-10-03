-- ---------------------------------------------------------------------------
-- One row per order, with everything the Orders screen shows.
--
-- The owner's ask (2026-10-04): an order in the list should show all of
-- itself - number, customer name, phone and address, the shipment number,
-- what they took, the shipping and the note - and the list should be
-- searchable by any of those and filterable. It also carries where the order
-- is now and since when, which is the tracker on each row.
--
-- A view rather than the client joining tables, for one practical reason:
-- PostgREST cannot put an embedded table's column inside an `or` filter, so
-- "order number, or shipment number, or phone, or name" could not be one
-- search. Flattened here, it is.
--
-- Read-only. security_invoker, so the same row-level rules as the tables
-- apply to whoever is reading.
-- ---------------------------------------------------------------------------

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
  )                          as stage_since
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
) li on true;

comment on view public.v_order_list is
  'Each order with its customer, current shipment, items, and which list it '
  'belongs in (stage) since when (stage_since). Backs the Orders screen.';

grant select on public.v_order_list to authenticated;
