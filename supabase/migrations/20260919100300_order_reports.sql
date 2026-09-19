-- ---------------------------------------------------------------------------
-- Phase 3: the screens that answer the daily questions.
--
-- What needs packing, what is still with the courier and shouldn't be, what
-- refusals are actually costing, and who keeps ordering and refusing.
-- ---------------------------------------------------------------------------

-- --- Customer risk ---------------------------------------------------------

alter table public.customers
  add column requires_prepayment boolean not null default false,
  add column risk_note           text;

comment on column public.customers.requires_prepayment is
  'Set by hand after repeated refusals. Surfaced as a warning before an order '
  'ships, so the decision is made before a courier run is paid for.';

-- --- The morning queue -----------------------------------------------------

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
  o.created_at,
  o.hold_until,
  o.confirmation_outcome,
  o.confirmation_attempts,
  c.id                       as customer_id,
  c.full_name                as customer_name,
  c.phone                    as customer_phone,
  c.governorate,
  c.requires_prepayment,
  -- How long this has been sitting. The number the queue sorts by.
  extract(epoch from (now() - o.created_at)) / 3600      as age_hours,
  (
    select coalesce(sum(li.quantity), 0)
      from public.order_line_items li where li.order_id = o.id
  )                          as unit_count,
  (
    select string_agg(li.sku || ' x' || li.quantity, ', ' order by li.created_at)
      from public.order_line_items li where li.order_id = o.id
  )                          as items,
  -- Prior refusals by this customer, which is the thing worth knowing before
  -- spending a courier run on them.
  (
    select count(*)
      from public.returns r
      join public.orders o2 on o2.id = r.order_id
     where o2.customer_id = c.id
       and r.type = 'failed_delivery'
  )                          as customer_prior_refusals
from public.orders o
left join public.customers c on c.id = o.customer_id
where o.fulfillment_status in (
        'awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed'
      )
  and (o.hold_until is null or o.hold_until <= current_date);

comment on view public.v_packing_queue is
  'Everything waiting on someone in the office, oldest first. Orders the '
  'customer asked us to hold drop out until their date arrives.';

-- --- Custody ---------------------------------------------------------------

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
  and s.status in ('in_transit', 'out_for_delivery', 'delivery_failed', 'return_in_transit');

comment on view public.v_courier_custody is
  'Every parcel currently with the courier. Sum units_out for the number of '
  'pieces outside the building right now.';

-- Delivery runs three to five days and a refusal comes back within two or
-- three, so anything past a week has stopped moving and needs a phone call.
-- This list, not the tracking, is the anti-theft control.
create or replace view public.v_custody_exceptions
with (security_invoker = on) as
select *
from public.v_courier_custody
where (status = 'return_in_transit' and days_in_custody > 7)
   or (status in ('in_transit', 'out_for_delivery') and days_in_custody > 10)
   or (status = 'delivery_failed' and days_in_custody > 7);

-- Returns that arrived short. Separate from the aged list because this is a
-- confirmed loss rather than a suspicion.
create or replace view public.v_return_discrepancies
with (security_invoker = on) as
select
  r.id            as return_id,
  r.status,
  r.reason,
  r.received_at,
  o.order_number,
  s.tracking_number,
  rl.sku,
  rl.quantity_expected,
  rl.quantity_received,
  rl.quantity_missing,
  rl.condition_note,
  c.full_name     as customer_name
from public.return_lines rl
join public.returns r on r.id = rl.return_id
join public.orders o on o.id = r.order_id
left join public.shipments s on s.id = r.outbound_shipment_id
left join public.customers c on c.id = o.customer_id
where rl.quantity_missing > 0;

-- --- Return rate, by cohort ------------------------------------------------
--
-- Measured against the week a parcel was handed over, not the week a return
-- happened. Returns this month over orders this month understates the rate
-- while the business is growing, and flatters it most in the best months.

create or replace view public.v_return_cohorts
with (security_invoker = on) as
with shipped as (
  select
    s.order_id,
    date_trunc('week', s.handed_over_at at time zone 'Africa/Cairo')::date as cohort_week,
    s.handed_over_at
  from public.shipments s
  where s.direction = 'outbound'
    and s.handed_over_at is not null
),
outcomes as (
  select
    sh.cohort_week,
    sh.order_id,
    sh.handed_over_at,
    exists (
      select 1 from public.returns r
       where r.order_id = sh.order_id and r.type = 'failed_delivery'
    ) as failed_delivery,
    exists (
      select 1 from public.returns r
       where r.order_id = sh.order_id and r.type in ('post_delivery', 'exchange')
    ) as post_delivery_return
  from shipped sh
)
select
  cohort_week,
  count(*)                                              as shipped,
  count(*) filter (where failed_delivery)               as failed_deliveries,
  count(*) filter (where post_delivery_return)          as post_delivery_returns,
  round(
    100.0 * count(*) filter (where failed_delivery) / nullif(count(*), 0), 1
  )                                                     as failed_delivery_pct,
  round(
    100.0 * count(*) filter (where post_delivery_return) / nullif(count(*), 0), 1
  )                                                     as post_delivery_pct,
  -- Three to five days out plus two or three back is about eight days at the
  -- outside, so fourteen leaves comfortable margin. Younger cohorts are still
  -- moving and must not be read as final.
  (max(handed_over_at) < now() - interval '14 days')    as is_mature
from outcomes
group by cohort_week;

comment on view public.v_return_cohorts is
  'Return rate by the week the parcel shipped. Rows with is_mature false are '
  'still collecting returns and will get worse.';

-- --- What refusals cost ----------------------------------------------------

create or replace view public.v_refusal_costs
with (security_invoker = on) as
select
  date_trunc('month', s.received_at)::date as month,
  sl.outcome,
  count(*)                                 as occurrences,
  sum(sl.fee_egp)                          as fees_egp,
  -- Nothing collected and a fee charged, so this is money out.
  sum(-sl.net_egp) filter (where sl.net_egp < 0) as cost_egp
from public.settlement_lines sl
join public.courier_settlements s on s.id = sl.settlement_id
where sl.outcome <> 'delivered'
group by 1, 2;

comment on view public.v_refusal_costs is
  'The monthly cost of failed deliveries, taken from what the courier actually '
  'charged rather than from an estimate.';

-- --- Who keeps refusing ----------------------------------------------------

create or replace view public.v_customer_reliability
with (security_invoker = on) as
select
  c.id                as customer_id,
  c.full_name,
  c.phone,
  c.governorate,
  c.requires_prepayment,
  count(distinct o.id)                                       as orders_placed,
  count(distinct o.id) filter (
    where o.fulfillment_status = 'delivered'
  )                                                          as delivered,
  count(distinct r.order_id) filter (
    where r.type = 'failed_delivery'
  )                                                          as refusals,
  count(distinct r.order_id) filter (
    where r.type = 'post_delivery'
  )                                                          as returns_after_delivery,
  round(
    100.0 * count(distinct r.order_id) filter (where r.type = 'failed_delivery')
      / nullif(count(distinct o.id), 0), 1
  )                                                          as refusal_pct,
  max(o.created_at)                                          as last_order_at
from public.customers c
join public.orders o on o.customer_id = c.id
left join public.returns r on r.order_id = o.id
group by c.id;

comment on view public.v_customer_reliability is
  'Ordering and refusal history per customer. The basis for the warning shown '
  'before an order ships, and for deciding who should prepay.';

-- --- Money still owed to us ------------------------------------------------

create or replace view public.v_unsettled_orders
with (security_invoker = on) as
select
  o.id            as order_id,
  o.order_number,
  o.total_egp,
  o.shipping_egp,
  o.payment_method,
  s.tracking_number,
  s.delivered_at,
  s.cod_amount_egp,
  extract(epoch from (now() - coalesce(s.delivered_at, s.handed_over_at))) / 86400
                  as days_since_delivery,
  c.full_name     as customer_name
from public.orders o
join public.shipments s on s.order_id = o.id and s.direction = 'outbound'
left join public.customers c on c.id = o.customer_id
where o.payment_status = 'pending'
  and o.fulfillment_status = 'delivered';

comment on view public.v_unsettled_orders is
  'Delivered, but the money has not been matched to a settlement yet. If a row '
  'here is older than the courier normally takes to remit, chase it.';

grant select on
  public.v_packing_queue,
  public.v_courier_custody,
  public.v_custody_exceptions,
  public.v_return_discrepancies,
  public.v_return_cohorts,
  public.v_refusal_costs,
  public.v_customer_reliability,
  public.v_unsettled_orders
to authenticated;
