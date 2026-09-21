-- ---------------------------------------------------------------------------
-- A statement line carries its note through to the screen.
--
-- An adjustment has no order and no tracking code on purpose - it is a charge
-- against the whole statement - and its description lives in the note. The
-- statement view did not select the note, so the screen had nothing to show
-- for those rows and fell back to labelling them "unknown code", which is the
-- warning meant for a tracking number that matched nothing. A deduction
-- somebody deliberately entered was being presented as a problem to chase.
--
-- Appended at the end: CREATE OR REPLACE VIEW can only add columns.
-- ---------------------------------------------------------------------------

create or replace view public.v_settlement_statement
with (security_invoker = on) as
select
  s.id as settlement_id,
  s.reference,
  s.received_at,
  s.status,
  sl.id as line_id,
  sl.tracking_number,
  sl.outcome,
  sl.collected_egp,
  sl.fee_egp,
  sl.net_egp,
  o.order_number,
  c.full_name as customer_name,
  c.governorate,
  (
    select string_agg(li.title || ' ×' || li.quantity, ', ' order by li.title)
      from public.order_line_items li
     where li.order_id = sl.order_id
  ) as items,
  sl.note
from public.courier_settlements s
join public.settlement_lines sl on sl.settlement_id = s.id
left join public.orders o on o.id = sl.order_id
left join public.customers c on c.id = o.customer_id;
