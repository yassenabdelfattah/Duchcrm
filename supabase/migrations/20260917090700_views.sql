-- ---------------------------------------------------------------------------
-- Read models for the dashboard.
--
-- Every view is declared security_invoker so it runs with the privileges of
-- whoever is querying it. Without that flag a view runs as its owner and
-- quietly hands out rows the caller's own policies would have refused.
-- ---------------------------------------------------------------------------

create or replace view public.v_stock_overview
with (security_invoker = on) as
select
  v.id                                   as variant_id,
  v.sku,
  v.barcode,
  v.size,
  v.color,
  v.price_egp,
  v.is_active,
  v.track_inventory,
  v.low_stock_threshold,
  p.id                                   as product_id,
  p.title                                as product_title,
  p.title_ar                             as product_title_ar,
  p.status                               as product_status,
  p.image_url,
  l.id                                   as location_id,
  l.name                                 as location_name,
  coalesce(sl.quantity, 0)               as quantity,
  sl.updated_at                          as stock_updated_at,
  sl.shopify_pushed_quantity,
  sl.shopify_pushed_at,
  (coalesce(sl.quantity, 0) <= 0)        as is_out_of_stock,
  (coalesce(sl.quantity, 0) > 0
    and coalesce(sl.quantity, 0) <= v.low_stock_threshold) as is_low_stock,
  (v.shopify_inventory_item_id is null)  as is_unlinked
from public.variants v
join public.products p on p.id = v.product_id
cross join public.locations l
left join public.stock_levels sl
  on sl.variant_id = v.id and sl.location_id = l.id
where l.is_active;

comment on view public.v_stock_overview is
  'One row per variant per active location, including variants that have never '
  'moved - those are the ones a stock count most needs to show.';

create or replace view public.v_low_stock
with (security_invoker = on) as
select *
from public.v_stock_overview
where is_active
  and track_inventory
  and product_status = 'active'
  and (is_out_of_stock or is_low_stock);

create or replace view public.v_stock_movement_feed
with (security_invoker = on) as
select
  m.id,
  m.created_at,
  m.quantity_delta,
  m.reason,
  m.reference_type,
  m.reference_id,
  m.note,
  v.id      as variant_id,
  v.sku,
  v.size,
  v.color,
  p.title   as product_title,
  l.name    as location_name,
  s.id      as staff_id,
  s.full_name as staff_name
from public.stock_movements m
join public.variants v on v.id = m.variant_id
join public.products p on p.id = v.product_id
join public.locations l on l.id = m.location_id
left join public.staff s on s.id = m.staff_id;

comment on view public.v_stock_movement_feed is
  'The ledger, readable. Every row answers what changed, by how much, why and who.';

create or replace view public.v_sales_summary_daily
with (security_invoker = on) as
select
  (o.created_at at time zone 'Africa/Cairo')::date as sale_date,
  o.channel,
  o.payment_method,
  count(*)                                        as order_count,
  sum(o.total_egp)                                as revenue_egp,
  sum(li.units)                                   as units_sold
from public.orders o
join lateral (
  select coalesce(sum(quantity), 0) as units
    from public.order_line_items
   where order_id = o.id
) li on true
where o.status not in ('cancelled', 'draft')
group by 1, 2, 3;

-- Stock valuation is restricted to roles that can read variant_costs. Because
-- the view is security_invoker, a sales user querying it simply gets no rows
-- rather than an error - the join to variant_costs finds nothing for them.
create or replace view public.v_stock_valuation
with (security_invoker = on) as
select
  v.id        as variant_id,
  v.sku,
  p.title     as product_title,
  l.name      as location_name,
  sl.quantity,
  vc.cost_egp,
  round(sl.quantity * vc.cost_egp, 2) as stock_value_egp
from public.stock_levels sl
join public.variants v on v.id = sl.variant_id
join public.products p on p.id = v.product_id
join public.locations l on l.id = sl.location_id
join public.variant_costs vc on vc.variant_id = v.id
where sl.quantity > 0;

grant select on public.v_stock_overview       to authenticated;
grant select on public.v_low_stock            to authenticated;
grant select on public.v_stock_movement_feed  to authenticated;
grant select on public.v_sales_summary_daily  to authenticated;
grant select on public.v_stock_valuation      to authenticated;
