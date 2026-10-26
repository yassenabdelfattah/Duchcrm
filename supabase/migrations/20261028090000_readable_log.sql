-- The log says where a piece went and why (2026-10-28).
--
-- Every stock movement records what it belongs to - an order, a Shopify
-- order, a return, a piece taken out for a photoshoot - in reference_type
-- and reference_id. v_activity_log never looked them up: a stock row carried
-- no order number, and its note was not shown either, so the owner could see
-- that a hoodie left the shelf and not where to or why.
--
-- v_log resolves each one: the order (and its customer) a piece was sold,
-- cancelled, edited or returned on; who has it and why when it was taken
-- out; Shopify when it was a count put right at reconciliation. Its
-- search_text holds all of it, so one box finds a row by product, SKU, order,
-- customer, person or note.

create or replace view public.v_log
with (security_invoker = on) as

select
  'stock'::text as kind,
  m.id,
  m.created_at,
  -- Cairo, not UTC: a UTC date puts anything after 9pm on the wrong day.
  (m.created_at at time zone 'Africa/Cairo')::date as activity_date,
  st.full_name as staff_name,
  m.reason::text as action,
  null::text as event_type,
  null::text as from_status,
  m.quantity_delta,
  m.variant_id,
  v.sku,
  p.title as product_title,
  nullif(concat_ws(' / ', v.size, v.color), '') as variant_label,
  l.name as location_name,
  m.note,
  m.reference_type,
  ord.id as order_id,
  ord.order_number,
  ord.channel as order_channel,
  ord.customer_name,
  so.taken_by,
  so.reason::text as taken_out_reason,
  so.reason_text as taken_out_reason_text,
  concat_ws(' ', v.sku, p.title, v.size, v.color, ord.order_number, ord.customer_name,
            st.full_name, m.note, so.taken_by, so.reason_text, so.note) as search_text,
  -- What was written on the taking-out itself, apart from who and why.
  so.note as taken_out_note
from public.stock_movements m
left join public.variants v on v.id = m.variant_id
left join public.products p on p.id = v.product_id
left join public.staff st on st.id = m.staff_id
left join public.locations l on l.id = m.location_id
-- The order it belongs to. Each test is guarded by a CASE so a reference of
-- another shape is never cast.
left join lateral (
  select o.id, o.order_number, o.channel::text as channel, c.full_name as customer_name
    from public.orders o
    left join public.customers c on c.id = o.customer_id
   where o.id = case
                  when m.reference_type in ('order', 'order_cancellation')
                   and m.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then m.reference_id::uuid
                  when m.reference_type = 'return'
                   and m.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (select r.order_id from public.returns r where r.id = m.reference_id::uuid)
                end
      or o.shopify_order_id = case
                                when m.reference_type in ('shopify_order', 'shopify_order_edit', 'pre_crm_cleanup')
                                 and m.reference_id ~ '^[0-9]{1,18}$'
                                  then m.reference_id::bigint
                              end
   limit 1
) ord on true
-- Who has it, and why, when it was taken out or came back.
left join public.stock_outs so
  on m.reference_type = 'stock_out'
 and so.id = case
               when m.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then m.reference_id::uuid
             end

union all

select
  'order'::text as kind,
  e.id,
  e.created_at,
  (e.created_at at time zone 'Africa/Cairo')::date as activity_date,
  st.full_name as staff_name,
  -- What actually changed, rather than the bare event name: "delivered" and
  -- "paid" are what someone is looking for, not "fulfillment_change".
  coalesce(e.to_fulfillment::text, e.to_payment::text, e.event_type) as action,
  e.event_type,
  coalesce(e.from_fulfillment::text, e.from_payment::text) as from_status,
  null::integer as quantity_delta,
  null::uuid as variant_id,
  null::text as sku,
  null::text as product_title,
  null::text as variant_label,
  null::text as location_name,
  e.note,
  null::text as reference_type,
  o.id as order_id,
  o.order_number,
  o.channel::text as order_channel,
  c.full_name as customer_name,
  null::text as taken_by,
  null::text as taken_out_reason,
  null::text as taken_out_reason_text,
  concat_ws(' ', o.order_number, c.full_name, c.phone, st.full_name, e.note) as search_text,
  null::text as taken_out_note
from public.order_events e
join public.orders o on o.id = e.order_id
left join public.customers c on c.id = o.customer_id
left join public.staff st on st.id = e.staff_id;

comment on view public.v_log is
  'Every stock movement and order change, newest first when ordered by created_at: '
  'what happened, to which order and customer, who has a piece taken out and why. '
  'search_text holds all of it for one search box.';
