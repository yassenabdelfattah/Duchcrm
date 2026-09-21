-- ---------------------------------------------------------------------------
-- Orders taken by hand: the channel decides where the goods are, the payment
-- method decides where the money is, and shipping is charged on top.
--
-- These two statuses move on separate timelines and the bugs live in the
-- gaps between them - an order that says paid because it was typed in at a
-- counter screen, or one that says delivered while it is still in a van.
-- ---------------------------------------------------------------------------

begin;
select plan(19);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('dddddddd-0000-0000-0000-000000000001', 'Manual Order Shop', 'store', false, true);

insert into public.products (id, title)
values ('dddddddd-0000-0000-0000-000000000002', 'Manual Test Hoodie');

insert into public.variants (id, product_id, sku, size, color, price_egp)
values ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000002',
        'MAN-HOOD-M', 'M', 'Black', 1000.00);

insert into auth.users (id, email, aud, role)
values ('dddddddd-0000-0000-0000-00000000000a', 'manual-seller@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'sales', is_active = true
 where id = 'dddddddd-0000-0000-0000-00000000000a';

select public.record_stock_movements(
  'dddddddd-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"dddddddd-0000-0000-0000-000000000003","quantity_delta":20}]'::jsonb
);

-- --- A counter sale is finished the moment it is rung up -------------------

select lives_ok(
  $$ select public.create_store_sale(
       'dddddddd-0000-0000-0000-000000000001', 'cash',
       '[{"variant_id":"dddddddd-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
       'manual-counter-cash-01', null, 0, null, 'store'
     ) $$,
  'A counter sale still works'
);

select is(
  (select fulfillment_status::text from public.orders where idempotency_key = 'manual-counter-cash-01'),
  'delivered',
  'A counter sale is delivered: it was handed over'
);

select is(
  (select payment_status::text from public.orders where idempotency_key = 'manual-counter-cash-01'),
  'paid',
  'A counter sale paid in cash is paid'
);

-- --- A DM order is only just beginning -------------------------------------

select lives_ok(
  $$ select public.create_store_sale(
       'dddddddd-0000-0000-0000-000000000001', 'cod',
       '[{"variant_id":"dddddddd-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
       'manual-dm-cod-01', null, 0, null, 'dm', 70
     ) $$,
  'An order can be taken for a DM customer'
);

select is(
  (select fulfillment_status::text from public.orders where idempotency_key = 'manual-dm-cod-01'),
  'awaiting_confirmation',
  'A DM order starts at the front of the packing queue, not delivered'
);

select is(
  (select payment_status::text from public.orders where idempotency_key = 'manual-dm-cod-01'),
  'pending',
  'Cash on delivery is not paid until the courier settlement is reviewed'
);

select is(
  (select shipping_egp from public.orders where idempotency_key = 'manual-dm-cod-01'),
  70.00,
  'Shipping is recorded'
);

-- The trap this guards: shipping must not be folded into the goods total,
-- because the invoice adds them and would otherwise charge it twice.
select is(
  (select total_egp from public.orders where idempotency_key = 'manual-dm-cod-01'),
  1000.00,
  'total_egp is the goods only - shipping is charged on top, not inside'
);

-- --- Paying later is a tab -------------------------------------------------

select lives_ok(
  $$ select public.create_store_sale(
       'dddddddd-0000-0000-0000-000000000001', 'deferred',
       '[{"variant_id":"dddddddd-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
       'manual-tab-01', null, 0, null, 'store'
     ) $$,
  'Goods can go out on a tab'
);

select is(
  (select payment_status::text from public.orders where idempotency_key = 'manual-tab-01'),
  'pending',
  'A tab is not paid'
);

select is(
  (select fulfillment_status::text from public.orders where idempotency_key = 'manual-tab-01'),
  'delivered',
  'A tab still hands the goods over'
);

-- The whole point of a tab: the stock really has gone.
select is(
  (select quantity from public.stock_levels
    where variant_id = 'dddddddd-0000-0000-0000-000000000003'),
  16,
  'Stock left the building for all four units sold'
);

-- --- Settling the tab ------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000000a","app_metadata":{"staff_role":"sales"}}';

select lives_ok(
  $$ select public.mark_order_paid(
       (select id from public.orders where idempotency_key = 'manual-tab-01')
     ) $$,
  'A sales user can settle a tab'
);

reset role;

select is(
  (select payment_status::text from public.orders where idempotency_key = 'manual-tab-01'),
  'paid',
  'Settling the tab marks it paid'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = (select id from public.orders where idempotency_key = 'manual-tab-01')
      and to_payment = 'paid'),
  1,
  'Settling is recorded as one payment event, with a name against it'
);

-- Idempotent: a second tap must not write a second payment event.
select lives_ok(
  $$ select public.mark_order_paid(
       (select id from public.orders where idempotency_key = 'manual-tab-01')
     ) $$,
  'Settling twice is not an error'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = (select id from public.orders where idempotency_key = 'manual-tab-01')
      and to_payment = 'paid'),
  1,
  'Settling twice still leaves exactly one payment event'
);

-- --- Cash on delivery keeps its single path to paid ------------------------

select throws_ok(
  $$ select public.mark_order_paid(
       (select id from public.orders where idempotency_key = 'manual-dm-cod-01')
     ) $$,
  '23001',
  null,
  'A cash-on-delivery order cannot be marked paid by hand - only a settlement does that'
);

select is(
  (select payment_status::text from public.orders where idempotency_key = 'manual-dm-cod-01'),
  'pending',
  'The refused attempt left it pending'
);

select * from finish();
rollback;
