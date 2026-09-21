-- ---------------------------------------------------------------------------
-- The log.
--
-- Everything that happens in this system is already recorded. Every stock
-- movement carries who moved it, when, why and against what. Every order
-- carries each status it passed through and who changed it. None of it was
-- visible anywhere: the dashboard showed the last twelve stock movements and
-- today's takings, and that was the whole of it.
--
-- So the owner of the business could not answer "what happened last Tuesday",
-- "who adjusted that stock", or "when did this order become paid" - which are
-- the questions an append-only ledger exists to answer. The data was right
-- and unreachable.
--
-- One chronological stream, because that is how the questions are asked. Two
-- kinds of thing in it: stock moving, and orders changing state.
--
-- security_invoker so the log obeys the same row level security as the tables
-- underneath it. A packing user reading the log sees exactly what a packing
-- user may see.
-- ---------------------------------------------------------------------------

create or replace view public.v_activity_log
with (security_invoker = on) as

select
  'stock'::text as kind,
  m.id,
  -- Cairo, not UTC. Egypt runs summer time, so a UTC date puts anything after
  -- 9pm on the wrong day for a third of the year - and a report whose days
  -- are off by one is worse than no report.
  (m.created_at at time zone 'Africa/Cairo')::date as activity_date,
  m.created_at,
  st.full_name as staff_name,
  m.reason::text as action,
  m.quantity_delta,
  v.sku,
  p.title as product_title,
  null::text as order_number,
  l.name as location_name,
  m.note
from public.stock_movements m
left join public.variants v on v.id = m.variant_id
left join public.products p on p.id = v.product_id
left join public.staff st on st.id = m.staff_id
left join public.locations l on l.id = m.location_id

union all

select
  'order'::text as kind,
  e.id,
  (e.created_at at time zone 'Africa/Cairo')::date as activity_date,
  e.created_at,
  st.full_name as staff_name,
  -- What actually changed, rather than the bare event name: "delivered" and
  -- "paid" are what someone is looking for, not "fulfillment_change".
  coalesce(e.to_fulfillment::text, e.to_payment::text, e.event_type) as action,
  null::integer as quantity_delta,
  null::text as sku,
  null::text as product_title,
  o.order_number,
  null::text as location_name,
  e.note
from public.order_events e
join public.orders o on o.id = e.order_id
left join public.staff st on st.id = e.staff_id;

comment on view public.v_activity_log is
  'Every stock movement and order state change, one stream, dated in Cairo.';
