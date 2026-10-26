-- Reports count sales the way Shopify does (2026-10-28).
--
-- v_sales_summary_daily counted an order's whole value on the day it was
-- placed and never took it back: the eleven orders refused or returned so far
-- were all still in "revenue". The owner chose Shopify's way:
--
--   gross sales  price x quantity of everything ordered, on the day ordered
--   discounts    line discounts and each line's share of the order discount
--   returns      what came back, at what it sold for, on the day it came back
--   net sales    gross - discounts - returns
--
-- and never a cancelled order. These three views are the facts every report
-- is built from - one row per line sold, per piece returned, per order - all
-- dated in Cairo. Orders archived as from before the CRM are left out.

-- --- What was sold ---------------------------------------------------------------------

create or replace view public.v_report_lines
with (security_invoker = on) as
select
  li.id as line_id,
  o.id as order_id,
  o.order_number,
  (o.created_at at time zone 'Africa/Cairo')::date as placed_on,
  o.channel::text as channel,
  o.payment_method::text as payment_method,
  c.governorate,
  o.customer_id,
  v.product_id,
  coalesce(p.title, li.title) as product_title,
  li.variant_id,
  li.sku,
  v.size,
  v.color,
  li.quantity,
  round(li.unit_price_egp * li.quantity, 2) as gross_egp,
  round(li.unit_price_egp * li.quantity, 2) - nl.net_egp as discounts_egp,
  nl.net_egp
from public.order_line_items li
join public.orders o on o.id = li.order_id
left join public.customers c on c.id = o.customer_id
left join public.variants v on v.id = li.variant_id
left join public.products p on p.id = v.product_id
-- The line after its own discount and its share of the order's.
cross join lateral (
  select round(
           li.total_egp * case when o.subtotal_egp > 0 then o.total_egp / o.subtotal_egp else 1 end,
           2) as net_egp
) nl
where o.archived_at is null
  and o.cancelled_at is null
  and o.fulfillment_status <> 'cancelled';

comment on view public.v_report_lines is
  'One row per line sold, on the Cairo day the order was placed: gross, discounts '
  'and net after the order discount. Never a cancelled or archived order.';

-- --- What came back --------------------------------------------------------------------------

create or replace view public.v_report_returns
with (security_invoker = on) as
select
  rl.id as return_line_id,
  r.id as return_id,
  o.id as order_id,
  o.order_number,
  -- The day it came back; until it is checked in, the day it was reported.
  (coalesce(r.received_at, r.courier_reported_at, r.created_at) at time zone 'Africa/Cairo')::date
    as returned_on,
  r.type::text as return_type,
  r.reason::text as reason,
  o.channel::text as channel,
  c.governorate,
  o.customer_id,
  v.product_id,
  coalesce(p.title, li.title) as product_title,
  rl.variant_id,
  rl.sku,
  v.size,
  v.color,
  rl.quantity_expected as quantity,
  -- At what it sold for, after discounts: what the sale is worth less.
  round(
    case when li.quantity > 0
         then li.total_egp * case when o.subtotal_egp > 0 then o.total_egp / o.subtotal_egp else 1 end
              / li.quantity
         else 0 end
    * rl.quantity_expected,
    2) as value_egp
from public.return_lines rl
join public.returns r on r.id = rl.return_id
join public.orders o on o.id = r.order_id
left join public.order_line_items li on li.id = rl.order_line_item_id
left join public.customers c on c.id = o.customer_id
left join public.variants v on v.id = rl.variant_id
left join public.products p on p.id = v.product_id
where o.archived_at is null;

comment on view public.v_report_returns is
  'One row per piece expected back, on the Cairo day it came back, valued at what '
  'it sold for. failed_delivery is a refusal; post_delivery a return after delivery.';

-- --- Each order --------------------------------------------------------------------------------

create or replace view public.v_report_orders
with (security_invoker = on) as
select
  o.id as order_id,
  o.order_number,
  (o.created_at at time zone 'Africa/Cairo')::date as placed_on,
  o.channel::text as channel,
  o.payment_method::text as payment_method,
  c.governorate,
  o.customer_id,
  c.full_name as customer_name,
  c.phone as customer_phone,
  o.exchange_for_order_id is not null as is_exchange,
  o.fulfillment_status::text as fulfillment_status,
  o.subtotal_egp,
  o.total_egp as net_egp,
  o.shipping_egp,
  coalesce(units.quantity, 0) as units,
  sh.courier,
  (sh.handed_over_at at time zone 'Africa/Cairo')::date as shipped_on,
  (sh.delivered_at at time zone 'Africa/Cairo')::date as delivered_on,
  -- How it ended: refused at the door, sent back after delivery, delivered,
  -- or not finished yet.
  case
    when ret.refused then 'refused'
    when ret.returned then 'returned'
    when o.fulfillment_status = 'delivered' then 'delivered'
    else 'open'
  end as outcome,
  -- Which of this customer's orders it was: 1 is a new customer.
  case when o.customer_id is not null then
    row_number() over (partition by o.customer_id order by o.created_at, o.id)
  end as customer_order_no
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sum(li.quantity)::integer as quantity
    from public.order_line_items li where li.order_id = o.id
) units on true
left join lateral (
  select s.courier, s.handed_over_at, s.delivered_at
    from public.shipments s
   where s.order_id = o.id and s.direction = 'outbound' and s.status <> 'cancelled'
   order by s.created_at desc
   limit 1
) sh on true
left join lateral (
  select bool_or(r.type = 'failed_delivery') as refused,
         bool_or(r.type = 'post_delivery') as returned
    from public.returns r where r.order_id = o.id
) ret on true
where o.archived_at is null
  and o.cancelled_at is null
  and o.fulfillment_status <> 'cancelled';

comment on view public.v_report_orders is
  'One row per order that counts - not cancelled, not from before the CRM: when '
  'placed, where to, how it ended, and whether it was the customer''s first.';
