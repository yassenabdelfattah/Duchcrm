-- ---------------------------------------------------------------------------
-- The in-store sale: one action that records the sale and moves the stock,
-- or does neither.
-- ---------------------------------------------------------------------------

begin;
select plan(16);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('bbbbbbbb-0000-0000-0000-000000000002', 'Test Jacket');

insert into public.variants (id, product_id, sku, size, color, price_egp)
values
  ('bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'JKT-BLK-M', 'M', 'Black', 2000.00),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', 'JKT-BLK-L', 'L', 'Black', 2000.00);

insert into auth.users (id, email, aud, role)
values
  ('bbbbbbbb-0000-0000-0000-00000000000a', 'seller@test.local', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'boss@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'sales', is_active = true
 where id = 'bbbbbbbb-0000-0000-0000-00000000000a';

update public.staff set role = 'admin', is_active = true
 where id = 'bbbbbbbb-0000-0000-0000-00000000000b';

select public.record_stock_movements(
  'bbbbbbbb-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000003","quantity_delta":5},
    {"variant_id":"bbbbbbbb-0000-0000-0000-000000000004","quantity_delta":1}]'::jsonb
);

-- --- A sale, made by a sales user -----------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-00000000000a","app_metadata":{"staff_role":"sales"}}';

select lives_ok(
  $$ select public.create_store_sale(
       'bbbbbbbb-0000-0000-0000-000000000001',
       'cash',
       '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
       'sale-idem-key-00001'
     ) $$,
  'A sales user can ring up a sale'
);

reset role;

select is(
  (select quantity from public.stock_levels
    where variant_id = 'bbbbbbbb-0000-0000-0000-000000000003'),
  3,
  'The sale took two units out of stock'
);

select is(
  (select count(*)::int from public.orders where idempotency_key = 'sale-idem-key-00001'),
  1,
  'Exactly one order was created'
);

select is(
  (select total_egp from public.orders where idempotency_key = 'sale-idem-key-00001'),
  4000.00::numeric,
  'The total is two units at the variant price'
);

select is(
  (select sku from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where o.idempotency_key = 'sale-idem-key-00001'),
  'JKT-BLK-M',
  'The line item snapshots the SKU that was sold'
);

select is(
  (select staff_id from public.orders where idempotency_key = 'sale-idem-key-00001'),
  'bbbbbbbb-0000-0000-0000-00000000000a'::uuid,
  'The sale is attributed to the staff member who made it'
);

select alike(
  (select order_number from public.orders where idempotency_key = 'sale-idem-key-00001'),
  'S%',
  'A store sale gets an S-prefixed order number'
);

-- --- The ledger records why --------------------------------------------

select is(
  (select reason::text from public.stock_movements
    where reference_type = 'order'
      and reference_id = (select id::text from public.orders
                           where idempotency_key = 'sale-idem-key-00001')),
  'store_sale',
  'The movement is tagged as a store sale and points back at the order'
);

-- --- Retrying the same sale ------------------------------------------------

select is(
  (select (public.create_store_sale(
       'bbbbbbbb-0000-0000-0000-000000000001',
       'cash',
       '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
       'sale-idem-key-00001'
     )).id),
  (select id from public.orders where idempotency_key = 'sale-idem-key-00001'),
  'Confirming the same sale twice returns the original order'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'bbbbbbbb-0000-0000-0000-000000000003'),
  3,
  'The retry did not take another two units'
);

-- --- Prices come from the database, not the client ------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-00000000000a","app_metadata":{"staff_role":"sales"}}';

select public.create_store_sale(
  'bbbbbbbb-0000-0000-0000-000000000001',
  'cash',
  '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000003","quantity":1,"unit_price_egp":1}]'::jsonb,
  'sale-idem-key-00002'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select total_egp from public.orders where idempotency_key = 'sale-idem-key-00002'),
  2000.00::numeric,
  'A sales user cannot sell at a price of their own choosing'
);

-- --- An admin may override a price ----------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","app_metadata":{"staff_role":"admin"}}';

select public.create_store_sale(
  'bbbbbbbb-0000-0000-0000-000000000001',
  'instapay',
  '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000003","quantity":1,"unit_price_egp":1500}]'::jsonb,
  'sale-idem-key-00003'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select total_egp from public.orders where idempotency_key = 'sale-idem-key-00003'),
  1500.00::numeric,
  'An admin may deliberately sell at a different price'
);

-- --- A sale that cannot be supplied leaves nothing behind -----------------

select throws_ok(
  $$ select public.create_store_sale(
       'bbbbbbbb-0000-0000-0000-000000000001',
       'cash',
       '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000003","quantity":1},
         {"variant_id":"bbbbbbbb-0000-0000-0000-000000000004","quantity":50}]'::jsonb,
       'sale-idem-key-00004'
     ) $$,
  '23514',
  null,
  'A sale is refused when any line exceeds available stock'
);

select is(
  (select count(*)::int from public.orders where idempotency_key = 'sale-idem-key-00004'),
  0,
  'The refused sale left no order behind'
);

-- --- Cancelling ------------------------------------------------------------

select public.cancel_order(
  (select id from public.orders where idempotency_key = 'sale-idem-key-00002'),
  'Customer changed their mind'
);

select is(
  (select status::text from public.orders where idempotency_key = 'sale-idem-key-00002'),
  'cancelled',
  'The order is marked cancelled'
);

select is(
  (select count(*)::int from public.stock_movements
    where reference_type = 'order_cancellation'
      and reason = 'cancellation'),
  1,
  'Cancelling appends a compensating movement rather than deleting the original'
);

select * from finish();
rollback;
