-- ---------------------------------------------------------------------------
-- The Orders screen's archive: an order moves there when nothing is left to
-- do on it, and comes back out when something is.
-- ---------------------------------------------------------------------------

begin;
select plan(8);

insert into public.locations (id, name, type, is_default, is_active)
values ('f6f6f6f6-0000-0000-0000-000000000001', 'Archive Test Shop', 'store', false, true);
insert into public.products (id, title) values ('f6f6f6f6-0000-0000-0000-000000000002', 'Archive Tee');
insert into public.variants (id, product_id, sku, size, price_egp)
values ('f6f6f6f6-0000-0000-0000-00000000000a', 'f6f6f6f6-0000-0000-0000-000000000002', 'AR-M', 'M', 400.00),
       ('f6f6f6f6-0000-0000-0000-00000000000b', 'f6f6f6f6-0000-0000-0000-000000000002', 'AR-S', 'S', 300.00);
select public.record_stock_movements('f6f6f6f6-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"f6f6f6f6-0000-0000-0000-00000000000a","quantity_delta":20},
    {"variant_id":"f6f6f6f6-0000-0000-0000-00000000000b","quantity_delta":20}]'::jsonb);

create or replace function pg_temp.sale(p_key text, p_channel text, p_method text) returns uuid language sql as $$
  select (public.create_store_sale(
    p_location_id => 'f6f6f6f6-0000-0000-0000-000000000001',
    p_payment_method => p_method::public.payment_method,
    p_items => '[{"variant_id":"f6f6f6f6-0000-0000-0000-00000000000a","quantity":1}]'::jsonb,
    p_idempotency_key => p_key, p_channel => p_channel::public.sales_channel)).id;
$$;
create or replace function pg_temp.closed(p_id uuid) returns boolean language sql as $$
  select is_closed from public.v_order_list where id = p_id;
$$;

create temporary table t (k text primary key, id uuid) on commit drop;
insert into t values ('shop', pg_temp.sale('archive-shop-1', 'store', 'cash'));
insert into t values ('dm', pg_temp.sale('archive-dm-0001', 'dm', 'cod'));

select ok(pg_temp.closed((select id from t where k = 'shop')),
  'A shop sale paid at the counter has nothing left to do: archived');

select ok(not pg_temp.closed((select id from t where k = 'dm')),
  'An order waiting to ship is open');

update public.orders set fulfillment_status = 'delivered' where id = (select id from t where k = 'dm');
select ok(not pg_temp.closed((select id from t where k = 'dm')),
  'Delivered but not paid is open - it is owed');

select public.mark_order_paid((select id from t where k = 'dm'));
select ok(pg_temp.closed((select id from t where k = 'dm')),
  'Delivered and paid: archived');

-- An exchange to a cheaper piece leaves money owed back: the replacement
-- stays open until that is paid, and the original stays open while the old
-- piece is on its way back.
insert into t values ('ex', null);
update t set id = ((public.create_exchange(
  p_order_id => (select id from t where k = 'dm'),
  p_return_lines => jsonb_build_array(jsonb_build_object('order_line_item_id',
    (select li.id from public.order_line_items li where li.order_id = (select id from t where k = 'dm')), 'quantity', 1)),
  p_replacement_items => '[{"variant_id":"f6f6f6f6-0000-0000-0000-00000000000b","quantity":1}]'::jsonb,
  p_reason => 'faulty', p_in_store => false, p_shipping_egp => 0,
  p_idempotency_key => 'archive-exch-01') ->> 'replacement_order_id')::uuid) where k = 'ex';

select ok(not pg_temp.closed((select id from t where k = 'dm')),
  'An original whose old piece has not come back yet is open again');

update public.orders set fulfillment_status = 'delivered' where id = (select id from t where k = 'ex');
select ok(not pg_temp.closed((select id from t where k = 'ex')),
  'A replacement with 100 owed back to the customer is open');

select public.mark_exchange_refunded((select id from t where k = 'ex'));
select ok(pg_temp.closed((select id from t where k = 'ex')),
  '...and archived once it is paid back');

select public.cancel_order(pg_temp.sale('archive-dm-0002', 'dm', 'cod'), 'test');
select ok(pg_temp.closed((select id from public.orders where idempotency_key = 'archive-dm-0002')),
  'A cancelled order is archived');

select * from finish();
rollback;
