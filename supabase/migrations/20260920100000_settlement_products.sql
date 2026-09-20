-- ---------------------------------------------------------------------------
-- Phase 3: what the money was actually for.
--
-- The accountant keeps a paper ledger, and what he needs is not a list of
-- order numbers - it is "this transfer was three t-shirts, four shorts and two
-- hoodies, at these prices". Order numbers mean nothing to him; products and
-- prices are what he writes down.
--
-- So a statement gets a product rollup alongside the line detail, and it has
-- to reconcile: goods plus the shipping the customers paid, less what the
-- courier charged, equals the transfer.
-- ---------------------------------------------------------------------------

-- --- What was in one parcel ------------------------------------------------
--
-- Shown while entering a line, so the parcel can be checked against their
-- paper before it is committed.

create or replace function public.lookup_shipment_for_settlement(p_tracking text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_customer public.customers;
  v_settled  record;
begin
  if not (public.is_admin() or public.has_any_role('stock_manager') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may read settlements'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('found', false, 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Already on a statement. Worth knowing before it is keyed a second time.
  select s.reference, s.id into v_settled
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.order_id = v_order.id
   limit 1;

  return jsonb_build_object(
    'found', true,
    'tracking_number', v_shipment.tracking_number,
    'order_number', v_order.order_number,
    'fulfillment_status', v_order.fulfillment_status,
    'payment_status', v_order.payment_status,
    'customer_name', v_customer.full_name,
    'governorate', v_customer.governorate,
    'goods_egp', v_order.total_egp,
    'shipping_egp', v_order.shipping_egp,
    'expected_egp', v_shipment.cod_amount_egp,
    'already_on', v_settled.reference,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity,
               'unit_price_egp', li.unit_price_egp,
               'total_egp', li.total_egp
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       where li.order_id = v_order.id
    )
  );
end;
$$;

comment on function public.lookup_shipment_for_settlement is
  'What is in a parcel, for checking against the courier statement before the '
  'line is entered.';

revoke execute on function public.lookup_shipment_for_settlement(text) from public, anon;
grant execute on function public.lookup_shipment_for_settlement(text) to authenticated, service_role;

-- --- The products behind a transfer ----------------------------------------
--
-- Grouped by product and price rather than by SKU, because the accountant
-- writes "three hoodies at 1,450" and does not care which sizes they were.
-- Two rows appear for the same product if it sold at two different prices,
-- which is the distinction he does need.

create or replace view public.v_settlement_products
with (security_invoker = on) as
select
  sl.settlement_id,
  li.title,
  li.unit_price_egp,
  sum(li.quantity)::integer as quantity,
  sum(li.total_egp)         as total_egp
from public.settlement_lines sl
join public.order_line_items li on li.order_id = sl.order_id
-- Only the deliveries. A refused parcel brought no money in; it appears among
-- the deductions instead.
where sl.outcome = 'delivered'
group by sl.settlement_id, li.title, li.unit_price_egp;

comment on view public.v_settlement_products is
  'What a transfer was for, in the terms the accountant records: product, '
  'quantity, price.';

grant select on public.v_settlement_products to authenticated;

-- --- How the transfer adds up ----------------------------------------------

create or replace view public.v_settlement_breakdown
with (security_invoker = on) as
select
  sl.settlement_id,
  -- Goods on the delivered orders. This equals the product rollup above.
  coalesce(sum(o.total_egp)    filter (where sl.outcome = 'delivered'), 0) as goods_egp,
  -- Shipping the customers paid, which the courier collected along with it.
  coalesce(sum(o.shipping_egp) filter (where sl.outcome = 'delivered'), 0) as shipping_egp,
  coalesce(sum(sl.collected_egp), 0)                                       as collected_egp,
  coalesce(sum(sl.fee_egp), 0)                                             as fees_egp,
  coalesce(sum(sl.net_egp), 0)                                             as net_egp,
  -- Non-zero when the courier collected something other than the order was
  -- worth - a partial collection, or a correction on their side. Surfaced
  -- rather than hidden, so the accountant's figures still tie out.
  coalesce(sum(sl.collected_egp), 0)
    - coalesce(sum(o.total_egp)    filter (where sl.outcome = 'delivered'), 0)
    - coalesce(sum(o.shipping_egp) filter (where sl.outcome = 'delivered'), 0)
                                                                           as collection_difference_egp
from public.settlement_lines sl
left join public.orders o on o.id = sl.order_id
group by sl.settlement_id;

comment on view public.v_settlement_breakdown is
  'Goods plus shipping, less courier charges, equals the transfer. Any part '
  'that does not tie out lands in collection_difference_egp.';

grant select on public.v_settlement_breakdown to authenticated;
