-- ---------------------------------------------------------------------------
-- Exchanges: a piece swapped for another, by courier or in the shop.
--
-- What matters: the original order and its money are left alone; the
-- replacement carries only the difference; the new piece leaves stock at
-- once and the old one comes back only when it is checked in; a cheaper
-- replacement leaves money owed back to the customer.
-- ---------------------------------------------------------------------------

begin;
select plan(30);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('e5e5e5e5-0000-0000-0000-000000000001', 'Exchange Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('e5e5e5e5-0000-0000-0000-000000000002', 'Exchange Test Tee');

insert into public.variants (id, product_id, sku, size, price_egp)
values
  ('e5e5e5e5-0000-0000-0000-00000000000a', 'e5e5e5e5-0000-0000-0000-000000000002', 'EX-M',     'M',  500.00),
  ('e5e5e5e5-0000-0000-0000-00000000000b', 'e5e5e5e5-0000-0000-0000-000000000002', 'EX-L',     'L',  500.00),
  ('e5e5e5e5-0000-0000-0000-00000000000c', 'e5e5e5e5-0000-0000-0000-000000000002', 'EX-PRO',   'XL', 800.00),
  ('e5e5e5e5-0000-0000-0000-00000000000d', 'e5e5e5e5-0000-0000-0000-000000000002', 'EX-CHEAP', 'S',  300.00);

select public.record_stock_movements(
  'e5e5e5e5-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity_delta":10},
    {"variant_id":"e5e5e5e5-0000-0000-0000-00000000000b","quantity_delta":10},
    {"variant_id":"e5e5e5e5-0000-0000-0000-00000000000c","quantity_delta":10},
    {"variant_id":"e5e5e5e5-0000-0000-0000-00000000000d","quantity_delta":10}]'::jsonb
);

create or replace function pg_temp.stock(p_sku text) returns integer language sql as $$
  select sl.quantity from public.stock_levels sl join public.variants v on v.id = sl.variant_id
   where v.sku = p_sku and sl.location_id = 'e5e5e5e5-0000-0000-0000-000000000001';
$$;

-- An order delivered by courier and not yet paid for: one M, shipping 70.
create or replace function pg_temp.delivered_order(p_key text, p_items jsonb, p_channel text default 'dm',
                                                   p_method text default 'cod', p_discount numeric default 0)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  v_id := (public.create_store_sale(
    p_location_id => 'e5e5e5e5-0000-0000-0000-000000000001',
    p_payment_method => p_method::public.payment_method,
    p_items => p_items, p_idempotency_key => p_key,
    p_discount_egp => p_discount,
    p_channel => p_channel::public.sales_channel, p_shipping_egp => 70)).id;
  update public.orders set fulfillment_status = 'delivered' where id = v_id;
  return v_id;
end;
$$;

create or replace function pg_temp.line_of(p_order uuid, p_sku text) returns uuid language sql as $$
  select id from public.order_line_items where order_id = p_order and sku = p_sku;
$$;

create temporary table t (k text primary key, v jsonb) on commit drop;

insert into t values ('orig1', to_jsonb(pg_temp.delivered_order('exch-orig-0001',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity":1}]'::jsonb)));

-- --- By courier, same price: M for L ------------------------------------------

insert into t values ('ex1', public.create_exchange(
  p_order_id          => (select (v #>> '{}')::uuid from t where k = 'orig1'),
  p_return_lines      => jsonb_build_array(jsonb_build_object(
                           'order_line_item_id', pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'orig1'), 'EX-M'),
                           'quantity', 1)),
  p_replacement_items => '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000b","quantity":1}]'::jsonb,
  p_reason            => 'wrong_size',
  p_in_store          => false,
  p_shipping_egp      => 70,
  p_idempotency_key   => 'exch-swap-0001'
));

select is((select (v ->> 'amount_due_egp')::numeric from t where k = 'ex1'), 70.00,
  'Same price: the customer pays only the courier fee');

select is(
  (select row(o.discount_egp, o.total_egp, o.shipping_egp, o.payment_status, o.payment_method,
              o.fulfillment_status, o.exchange_for_order_id is not null)::text
     from public.orders o where o.id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex1')),
  '(500.00,0.00,70.00,pending,cod,ready_to_pack,t)',
  'The replacement is credited the old piece, collects the fee by courier, and goes straight to packing');

select is(pg_temp.stock('EX-L'), 9, 'The new piece leaves stock straight away');
select is(pg_temp.stock('EX-M'), 9, 'The old piece is not back until it is checked in');

select is(
  (select row(fulfillment_status, payment_status)::text from public.orders
    where id = (select (v #>> '{}')::uuid from t where k = 'orig1')),
  '(delivered,pending)',
  'The original order and its money are untouched');

select is(
  (select row(r.type, r.status, r.reason)::text from public.returns r
    where r.id = (select (v ->> 'return_id')::uuid from t where k = 'ex1')),
  '(exchange,expected,wrong_size)',
  'An exchange return is expected back');

select is(
  (select exchange_collect_items from public.v_packing_queue
    where order_id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex1')),
  'EX-M x1',
  'The packing queue says what the courier collects at the door');

select public.ship_order((select (v ->> 'replacement_order_id')::uuid from t where k = 'ex1'), 'EXCH-TRACK-1');

select ok(
  (select collects_return from public.shipments where tracking_number = 'EXCH-TRACK-1'),
  'The replacement''s parcel is marked as collecting the old piece');

select is(
  (select row(s.cod_amount_egp)::text from public.shipments s where tracking_number = 'EXCH-TRACK-1'),
  '(70.00)',
  'The courier collects 70 at the door');

select is(
  public.lookup_return_by_tracking('EXCH-TRACK-1') ->> 'state',
  'ready_to_receive',
  'Scanning the replacement''s parcel finds the old piece to check in');

select is(
  public.lookup_return_by_tracking('EXCH-TRACK-1') #>> '{exchange,original_order_number}',
  (select order_number from public.orders where id = (select (v #>> '{}')::uuid from t where k = 'orig1')),
  '...and says which order it was exchanged from');

select is(
  public.lookup_return_by_order_number(
    (select order_number from public.orders where id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex1'))
  ) ->> 'state',
  'ready_to_receive',
  'Typing the replacement''s number finds the exchange, not a fresh return of the replacement');

select public.receive_return(
  (select (v ->> 'return_id')::uuid from t where k = 'ex1'),
  (select jsonb_agg(jsonb_build_object('return_line_id', rl.id, 'quantity_resellable', 1, 'quantity_damaged', 0))
     from public.return_lines rl where rl.return_id = (select (v ->> 'return_id')::uuid from t where k = 'ex1'))
);

select is(pg_temp.stock('EX-M'), 10, 'Checked in, the old piece is back on the shelf');

select is(
  (select fulfillment_status::text from public.orders where id = (select (v #>> '{}')::uuid from t where k = 'orig1')),
  'delivered',
  'Checking the old piece in does not mark the original order returned - its money is still owed');

select is(
  (select (public.create_exchange(
     p_order_id          => (select (v #>> '{}')::uuid from t where k = 'orig1'),
     p_return_lines      => '[]'::jsonb,
     p_replacement_items => '[]'::jsonb,
     p_reason            => 'wrong_size',
     p_in_store          => false,
     p_idempotency_key   => 'exch-swap-0001') ->> 'replacement_order_id')),
  (select v ->> 'replacement_order_id' from t where k = 'ex1'),
  'The same exchange submitted twice is the same exchange');

select is(
  (select count(*)::integer from public.returns
    where order_id = (select (v #>> '{}')::uuid from t where k = 'orig1')),
  1,
  '...with one return, not two');

select throws_ok(
  format($$ select public.create_exchange(%L, jsonb_build_array(jsonb_build_object('order_line_item_id', %L, 'quantity', 1)),
           '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000b","quantity":1}]'::jsonb, 'wrong_size', false, 0, null, null, 'exch-swap-0002') $$,
         (select (v #>> '{}')::text from t where k = 'orig1'),
         pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'orig1'), 'EX-M')),
  '23514',
  'Only 0 of EX-M can still come back',
  'A piece already exchanged cannot be exchanged again');

-- --- In the shop, a dearer piece ------------------------------------------------

insert into t values ('orig2', to_jsonb(pg_temp.delivered_order('exch-orig-0002',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity":1}]'::jsonb, 'store', 'cash')));

insert into t values ('ex2', public.create_exchange(
  p_order_id          => (select (v #>> '{}')::uuid from t where k = 'orig2'),
  p_return_lines      => jsonb_build_array(jsonb_build_object(
                           'order_line_item_id', pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'orig2'), 'EX-M'),
                           'quantity', 1)),
  p_replacement_items => '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000c","quantity":1}]'::jsonb,
  p_reason            => 'not_as_expected',
  p_in_store          => true,
  p_payment_method    => 'instapay',
  p_idempotency_key   => 'exch-shop-0001'
));

select is((select (v ->> 'amount_due_egp')::numeric from t where k = 'ex2'), 300.00,
  'A dearer piece in the shop: the customer pays the 300 difference');

select is(
  (select row(o.channel, o.fulfillment_status, o.payment_status, o.payment_method, o.total_egp, o.shipping_egp)::text
     from public.orders o where o.id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex2')),
  '(store,delivered,paid,instapay,300.00,0.00)',
  '...handed over and paid at the counter, no shipping');

-- M was 10; this shop order took one (9), and the exchange brings it back.
select is(pg_temp.stock('EX-M'), 10, 'The old piece on the counter is back in stock at once');

select is(
  (select status::text from public.returns where id = (select (v ->> 'return_id')::uuid from t where k = 'ex2')),
  'received',
  '...and its return is already checked in');

-- --- A cheaper piece: money owed back ------------------------------------------------

insert into t values ('orig3', to_jsonb(pg_temp.delivered_order('exch-orig-0003',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity":1}]'::jsonb)));

insert into t values ('ex3', public.create_exchange(
  p_order_id          => (select (v #>> '{}')::uuid from t where k = 'orig3'),
  p_return_lines      => jsonb_build_array(jsonb_build_object(
                           'order_line_item_id', pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'orig3'), 'EX-M'),
                           'quantity', 1)),
  p_replacement_items => '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000d","quantity":1}]'::jsonb,
  p_reason            => 'faulty',
  p_in_store          => false,
  p_shipping_egp      => 0,
  p_idempotency_key   => 'exch-cheap-0001'
));

select is(
  (select row((v ->> 'amount_due_egp')::numeric, (v ->> 'refund_due_egp')::numeric)::text from t where k = 'ex3'),
  '(0.00,200.00)',
  'A cheaper piece, our fault: nothing to collect, 200 owed back');

select is(
  (select row(o.payment_status, o.exchange_refund_egp, o.exchange_refunded_at is null)::text
     from public.orders o where o.id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex3')),
  '(paid,200.00,t)',
  'Nothing to collect is not owed; the 200 stays owed back until someone pays it');

select public.mark_exchange_refunded((select (v ->> 'replacement_order_id')::uuid from t where k = 'ex3'), 'InstaPay');

select ok(
  (select exchange_refunded_at is not null from public.orders
    where id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex3')),
  'Paying it back is recorded');

-- In the shop the difference is handed back there and then.
insert into t values ('orig4', to_jsonb(pg_temp.delivered_order('exch-orig-0004',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity":1}]'::jsonb, 'store', 'cash')));
insert into t values ('ex4', public.create_exchange(
  p_order_id          => (select (v #>> '{}')::uuid from t where k = 'orig4'),
  p_return_lines      => jsonb_build_array(jsonb_build_object(
                           'order_line_item_id', pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'orig4'), 'EX-M'),
                           'quantity', 1, 'quantity_damaged', 1)),
  p_replacement_items => '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000d","quantity":1}]'::jsonb,
  p_reason            => 'faulty',
  p_in_store          => true,
  p_idempotency_key   => 'exch-cheap-0002'
));

select ok(
  (select exchange_refunded_at is not null from public.orders
    where id = (select (v ->> 'replacement_order_id')::uuid from t where k = 'ex4')),
  'In the shop a cheaper piece''s difference is given back at once');

-- M was 10; #3 and #4 each took one (8). #4's came back damaged, so still 8.
select is(pg_temp.stock('EX-M'), 8, 'A damaged piece checked in does not go back on the shelf');

-- --- An order discount is part of what the piece cost --------------------------------

insert into t values ('orig5', to_jsonb(pg_temp.delivered_order('exch-orig-0005',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity":1},
    {"variant_id":"e5e5e5e5-0000-0000-0000-00000000000b","quantity":1}]'::jsonb, 'dm', 'cod', 100)));
insert into t values ('ex5', public.create_exchange(
  p_order_id          => (select (v #>> '{}')::uuid from t where k = 'orig5'),
  p_return_lines      => jsonb_build_array(jsonb_build_object(
                           'order_line_item_id', pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'orig5'), 'EX-M'),
                           'quantity', 1)),
  p_replacement_items => '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000b","quantity":1}]'::jsonb,
  p_reason            => 'wrong_size',
  p_in_store          => false,
  p_shipping_egp      => 70,
  p_idempotency_key   => 'exch-disc-0001'
));

select is((select (v ->> 'credit_egp')::numeric from t where k = 'ex5'), 450.00,
  'A 500 piece from an order with 100 off two pieces is worth the 450 actually paid');

-- --- Calling a replacement off -------------------------------------------------------------

select public.cancel_order((select (v ->> 'replacement_order_id')::uuid from t where k = 'ex5'), 'Customer kept the M');

select is(
  (select status::text from public.returns where id = (select (v ->> 'return_id')::uuid from t where k = 'ex5')),
  'closed',
  'Cancelling the replacement closes the exchange: the old piece is not coming back');

-- --- Only delivered orders ----------------------------------------------------------------

insert into t values ('undelivered', to_jsonb((public.create_store_sale(
  p_location_id => 'e5e5e5e5-0000-0000-0000-000000000001', p_payment_method => 'cod',
  p_items => '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000a","quantity":1}]'::jsonb,
  p_idempotency_key => 'exch-orig-0006', p_channel => 'dm')).id));

select throws_ok(
  format($$ select public.create_exchange(%L, jsonb_build_array(jsonb_build_object('order_line_item_id', %L, 'quantity', 1)),
           '[{"variant_id":"e5e5e5e5-0000-0000-0000-00000000000b","quantity":1}]'::jsonb, 'wrong_size', false, 0, null, null, 'exch-undel-0001') $$,
         (select (v #>> '{}')::text from t where k = 'undelivered'),
         pg_temp.line_of((select (v #>> '{}')::uuid from t where k = 'undelivered'), 'EX-M')),
  '23514',
  null,
  'An order the customer does not have yet is edited, not exchanged');

select is(
  (select count(*)::integer from public.returns where order_id = (select (v #>> '{}')::uuid from t where k = 'undelivered')),
  0,
  '...and leaves no half-made exchange behind');

select * from finish();
rollback;
