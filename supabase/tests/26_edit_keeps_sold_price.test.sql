-- ---------------------------------------------------------------------------
-- An order keeps the prices it was sold at (2026-10-26).
--
-- A price change is for orders taken after it. Editing an order taken before
-- - more of the same, a size added, a line removed - must not re-price what
-- the customer already agreed to pay.
-- ---------------------------------------------------------------------------

begin;
select plan(10);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('a6a6a6a6-0000-0000-0000-000000000001', 'Price Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('a6a6a6a6-0000-0000-0000-000000000002', 'Price Test Hoodie');

insert into public.variants (id, product_id, sku, size, color, price_egp)
values
  ('a6a6a6a6-0000-0000-0000-000000000003', 'a6a6a6a6-0000-0000-0000-000000000002',
   'PRICE-HOOD-M', 'M', 'Black', 1000.00),
  ('a6a6a6a6-0000-0000-0000-000000000004', 'a6a6a6a6-0000-0000-0000-000000000002',
   'PRICE-HOOD-L', 'L', 'Black', 1000.00);

select public.record_stock_movements(
  'a6a6a6a6-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity_delta":20},
    {"variant_id":"a6a6a6a6-0000-0000-0000-000000000004","quantity_delta":20}]'::jsonb
);

-- Taken at 1,000: one medium hoodie.
select public.create_store_sale(
  'a6a6a6a6-0000-0000-0000-000000000001', 'cod',
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
  'price-order-0001', null, 0, null, 'dm', 70
);

-- A website order taken with 100 off two hoodies - 50 a piece.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp
) values (
  'a6a6a6a6-0000-0000-0000-0000000000a2', 'PRICE-DISC', 'online', 'awaiting_confirmation', 'pending',
  'a6a6a6a6-0000-0000-0000-000000000001', 'cod', 1900, 70, 1900
);

insert into public.order_line_items (
  order_id, variant_id, sku, title, variant_title, quantity, unit_price_egp, discount_egp, total_egp
) values (
  'a6a6a6a6-0000-0000-0000-0000000000a2', 'a6a6a6a6-0000-0000-0000-000000000003',
  'PRICE-HOOD-M', 'Price Test Hoodie', 'M / Black', 2, 1000, 100, 1900
);

-- Then the price goes up.
update public.variants set price_egp = 1200.00
 where product_id = 'a6a6a6a6-0000-0000-0000-000000000002';

-- --- More of the same, and a size added -------------------------------------

select public.update_order_items(
  (select id from public.orders where idempotency_key = 'price-order-0001'),
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":2},
    {"variant_id":"a6a6a6a6-0000-0000-0000-000000000004","quantity":1}]'::jsonb
);

select is(
  (select li.unit_price_egp from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where o.idempotency_key = 'price-order-0001' and li.sku = 'PRICE-HOOD-M'),
  1000.00::numeric(12, 2),
  'The hoodie already on the order keeps the price it was sold at'
);

select is(
  (select li.total_egp from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where o.idempotency_key = 'price-order-0001' and li.sku = 'PRICE-HOOD-M'),
  2000.00::numeric(12, 2),
  'And a second one of it is at that price too'
);

select is(
  (select li.unit_price_egp from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where o.idempotency_key = 'price-order-0001' and li.sku = 'PRICE-HOOD-L'),
  1200.00::numeric(12, 2),
  'A size new to the order is at today''s price'
);

select is(
  (select subtotal_egp from public.orders where idempotency_key = 'price-order-0001'),
  3200.00::numeric(12, 2),
  'The order adds up: two at the old price, one at the new'
);

-- --- Taken off, the old price stays on what remains -----------------------------

select public.update_order_items(
  (select id from public.orders where idempotency_key = 'price-order-0001'),
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":1}]'::jsonb
);

select is(
  (select subtotal_egp from public.orders where idempotency_key = 'price-order-0001'),
  1000.00::numeric(12, 2),
  'Back to one hoodie: back to what it was sold for'
);

-- --- A discount on the line goes with the piece ----------------------------------

select public.update_order_items(
  'a6a6a6a6-0000-0000-0000-0000000000a2',
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":3}]'::jsonb
);

select is(
  (select row(unit_price_egp, discount_egp, total_egp)::text from public.order_line_items
    where order_id = 'a6a6a6a6-0000-0000-0000-0000000000a2'),
  row(1000.00::numeric(12, 2), 150.00::numeric(12, 2), 2850.00::numeric(12, 2))::text,
  'A third hoodie is at the old price with the same 50 off'
);

select public.update_order_items(
  'a6a6a6a6-0000-0000-0000-0000000000a2',
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":3}]'::jsonb
);

select is(
  (select total_egp from public.orders where id = 'a6a6a6a6-0000-0000-0000-0000000000a2'),
  2850.00::numeric(12, 2),
  'Saving again with nothing changed changes nothing'
);

-- --- Someone allowed to set a price still can -------------------------------------

select public.update_order_items(
  'a6a6a6a6-0000-0000-0000-0000000000a2',
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":1,"unit_price_egp":900,"discount_egp":0}]'::jsonb
);

select is(
  (select row(unit_price_egp, discount_egp)::text from public.order_line_items
    where order_id = 'a6a6a6a6-0000-0000-0000-0000000000a2'),
  row(900.00::numeric(12, 2), 0.00::numeric(12, 2))::text,
  'A price and a discount given explicitly are used as given'
);

-- --- A new order takes today's price ------------------------------------------------

select public.create_store_sale(
  'a6a6a6a6-0000-0000-0000-000000000001', 'cod',
  '[{"variant_id":"a6a6a6a6-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
  'price-order-0002', null, 0, null, 'dm', 70
);

select is(
  (select subtotal_egp from public.orders where idempotency_key = 'price-order-0002'),
  1200.00::numeric(12, 2),
  'An order taken after the change is at the new price'
);

-- --- Stock still follows the box ------------------------------------------------------

select is(
  (select quantity from public.stock_levels
    where variant_id = 'a6a6a6a6-0000-0000-0000-000000000004'),
  20,
  'The large added and then taken off is back on the shelf'
);

select * from finish();
rollback;
