-- ---------------------------------------------------------------------------
-- Editing an order.
--
-- Two things are being protected here. Stock, because changing what is in the
-- box has to move the ledger and the ledger is append-only. And money, because
-- figures that have already been counted - against a bank transfer, or by the
-- settlement that marked an order paid - must not quietly change afterwards.
-- ---------------------------------------------------------------------------

begin;
select plan(22);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('eeeeeeee-0000-0000-0000-000000000001', 'Edit Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('eeeeeeee-0000-0000-0000-000000000002', 'Edit Test Hoodie');

insert into public.variants (id, product_id, sku, size, color, price_egp)
values
  ('eeeeeeee-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000002',
   'EDIT-HOOD-M', 'M', 'Black', 1000.00),
  ('eeeeeeee-0000-0000-0000-000000000004', 'eeeeeeee-0000-0000-0000-000000000002',
   'EDIT-HOOD-L', 'L', 'Black', 1000.00);

insert into auth.users (id, email, aud, role)
values ('eeeeeeee-0000-0000-0000-00000000000a', 'edit-seller@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'sales', is_active = true
 where id = 'eeeeeeee-0000-0000-0000-00000000000a';

select public.record_stock_movements(
  'eeeeeeee-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"eeeeeeee-0000-0000-0000-000000000003","quantity_delta":20},
    {"variant_id":"eeeeeeee-0000-0000-0000-000000000004","quantity_delta":20}]'::jsonb
);

-- An unpaid DM order: two of the M hoodie, 70 shipping.
select public.create_store_sale(
  'eeeeeeee-0000-0000-0000-000000000001', 'cod',
  '[{"variant_id":"eeeeeeee-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
  'edit-order-0001', null, 0, null, 'dm', 70
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'eeeeeeee-0000-0000-0000-000000000003'),
  18,
  'Two left the building when the order was taken'
);

-- --- Changing the figures --------------------------------------------------

select lives_ok(
  $$ select public.update_order_details(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       100, null, null, null, null
     ) $$,
  'The shipping fee can be corrected'
);

select is(
  (select shipping_egp from public.orders where idempotency_key = 'edit-order-0001'),
  100.00,
  'And it is what was asked for'
);

-- The trap: total_egp is the goods, and a shipping change must not touch it.
select is(
  (select total_egp from public.orders where idempotency_key = 'edit-order-0001'),
  2000.00,
  'Changing shipping leaves the goods total alone'
);

select lives_ok(
  $$ select public.update_order_details(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       null, 150, null, null, null
     ) $$,
  'A discount can be applied afterwards'
);

select is(
  (select total_egp from public.orders where idempotency_key = 'edit-order-0001'),
  1850.00,
  'And it comes off the goods total'
);

select throws_ok(
  $$ select public.update_order_details(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       null, 99999, null, null, null
     ) $$,
  '23514',
  null,
  'A discount larger than the order is refused'
);

select lives_ok(
  $$ select public.update_order_details(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       null, null, null, 'instapay', 'online'
     ) $$,
  'The payment method and the channel can be corrected'
);

select is(
  (select payment_method::text || '/' || channel::text from public.orders
    where idempotency_key = 'edit-order-0001'),
  'instapay/online',
  'Both changed'
);

-- --- Changing what is in the box -------------------------------------------

-- Down from two to one: a hoodie comes back.
select lives_ok(
  $$ select public.update_order_items(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       '[{"variant_id":"eeeeeeee-0000-0000-0000-000000000003","quantity":1}]'::jsonb
     ) $$,
  'An item quantity can be reduced'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'eeeeeeee-0000-0000-0000-000000000003'),
  19,
  'The hoodie that came off the order came back into stock'
);

select is(
  (select subtotal_egp from public.orders where idempotency_key = 'edit-order-0001'),
  1000.00,
  'The order is worth less now'
);

-- The correction is appended, never a rewrite: the original sale movement is
-- still there, and the return of one unit sits beside it.
select is(
  (select count(*)::int from public.stock_movements
    where reference_id = (select id::text from public.orders where idempotency_key = 'edit-order-0001')),
  2,
  'The original movement and its correction both exist - history was not rewritten'
);

-- Not "the most recent movement": now() is fixed for a whole transaction, so
-- both movements carry the same timestamp and ordering by it picks either.
select is(
  (select count(*)::int from public.stock_movements
    where reference_id = (select id::text from public.orders where idempotency_key = 'edit-order-0001')
      and reason = 'adjustment'),
  1,
  'The correction is an adjustment, not a second sale that would double-count revenue'
);

-- Swapping a size: one variant goes back, another goes out.
select lives_ok(
  $$ select public.update_order_items(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       '[{"variant_id":"eeeeeeee-0000-0000-0000-000000000004","quantity":1}]'::jsonb
     ) $$,
  'A customer can change size'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'eeeeeeee-0000-0000-0000-000000000003'),
  20,
  'The medium is fully back'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'eeeeeeee-0000-0000-0000-000000000004'),
  19,
  'And the large has gone out'
);

select throws_ok(
  $$ select public.update_order_items(
       (select id from public.orders where idempotency_key = 'edit-order-0001'),
       '[]'::jsonb
     ) $$,
  '22023',
  null,
  'Emptying an order is refused - cancelling is the way to do that'
);

-- --- Money that has been counted cannot move -------------------------------

select public.create_store_sale(
  'eeeeeeee-0000-0000-0000-000000000001', 'cash',
  '[{"variant_id":"eeeeeeee-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
  'edit-order-paid', null, 0, null, 'store'
);

select throws_ok(
  $$ select public.update_order_details(
       (select id from public.orders where idempotency_key = 'edit-order-paid'),
       null, 50, null, null, null
     ) $$,
  '23001',
  null,
  'A paid order will not let its money be edited'
);

select throws_ok(
  $$ select public.update_order_items(
       (select id from public.orders where idempotency_key = 'edit-order-paid'),
       '[{"variant_id":"eeeeeeee-0000-0000-0000-000000000003","quantity":5}]'::jsonb
     ) $$,
  '23001',
  null,
  'Nor its contents - that would move stock against money already counted'
);

-- A note is a correction to what someone wrote, not to the money.
select lives_ok(
  $$ select public.update_order_details(
       (select id from public.orders where idempotency_key = 'edit-order-paid'),
       null, null, 'customer called to confirm', null, null
     ) $$,
  'But the note can still be corrected on a paid order'
);

-- --- Every edit leaves a trace ---------------------------------------------

select isnt_empty(
  $$ select id from public.order_events
      where order_id = (select id from public.orders where idempotency_key = 'edit-order-0001')
        and event_type in ('edited', 'items_edited') $$,
  'Edits are recorded as events, so a changed order can be explained later'
);

select * from finish();
rollback;
