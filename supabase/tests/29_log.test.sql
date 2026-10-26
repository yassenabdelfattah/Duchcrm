-- ---------------------------------------------------------------------------
-- The log says where a piece went and why (2026-10-28): each stock movement
-- carries the order and customer it belongs to, or who has a piece taken out,
-- and one search finds a row by any of them.
-- ---------------------------------------------------------------------------

begin;
select plan(8);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('a9a9a9a9-0000-0000-0000-000000000001', 'Log Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('a9a9a9a9-0000-0000-0000-000000000002', 'Log Test Hoodie');

insert into public.variants (id, product_id, sku, size, color, price_egp)
values ('a9a9a9a9-0000-0000-0000-000000000003', 'a9a9a9a9-0000-0000-0000-000000000002',
        'LOG-HOOD-M', 'M', 'Black', 1000.00);

select public.record_stock_movements(
  'a9a9a9a9-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"a9a9a9a9-0000-0000-0000-000000000003","quantity_delta":10}]'::jsonb
);

insert into public.customers (id, full_name, phone)
values ('a9a9a9a9-0000-0000-0000-0000000000c1', 'Log Customer', '01599944455');

-- A sale in the shop, to a named customer.
select public.create_store_sale(
  'a9a9a9a9-0000-0000-0000-000000000001', 'cash',
  '[{"variant_id":"a9a9a9a9-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
  'log-sale-1', 'a9a9a9a9-0000-0000-0000-0000000000c1', 0, null, 'store'
);

-- A website order, its stock moved against the Shopify order id.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp, shopify_order_id
) values (
  'a9a9a9a9-0000-0000-0000-0000000000a2', '#LOG-1', 'online', 'awaiting_confirmation', 'pending',
  'a9a9a9a9-0000-0000-0000-000000000001', 'cod', 1000, 70, 1000, 9876543210123
);
select public.record_stock_movements(
  'a9a9a9a9-0000-0000-0000-000000000001', 'online_order',
  '[{"variant_id":"a9a9a9a9-0000-0000-0000-000000000003","quantity_delta":-1}]'::jsonb,
  'shopify_order', '9876543210123'
);

-- Two pieces out to a photographer.
select public.record_stock_out(
  'a9a9a9a9-0000-0000-0000-000000000001', 'photoshoot', null,
  '[{"variant_id":"a9a9a9a9-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
  'Joe the photographer', 'for the lookbook', true, null, 'log-out-1'
);

-- A reference of a shape the log does not resolve must not break it.
select public.record_stock_movements(
  'a9a9a9a9-0000-0000-0000-000000000001', 'adjustment',
  '[{"variant_id":"a9a9a9a9-0000-0000-0000-000000000003","quantity_delta":1}]'::jsonb,
  'order', 'not-a-uuid', 'odd reference'
);

-- --- What the log says ------------------------------------------------------------

select is(
  (select row(order_number, customer_name, order_channel)::text from public.v_log
    where kind = 'stock' and action = 'store_sale' and sku = 'LOG-HOOD-M'),
  row((select order_number from public.orders where idempotency_key = 'log-sale-1'), 'Log Customer', 'store')::text,
  'A sale names the order and the customer it went to'
);

select is(
  (select order_number from public.v_log
    where kind = 'stock' and action = 'online_order' and sku = 'LOG-HOOD-M'),
  '#LOG-1',
  'A website sale recorded against the Shopify order id still names the order'
);

select is(
  (select row(taken_by, taken_out_reason, taken_out_note, quantity_delta)::text from public.v_log
    where kind = 'stock' and action = 'stock_out' and sku = 'LOG-HOOD-M'),
  row('Joe the photographer', 'photoshoot', 'for the lookbook', -2)::text,
  'A piece taken out says who has it and why'
);

select is(
  (select row(variant_label, product_title)::text from public.v_log
    where kind = 'stock' and action = 'stock_out' and sku = 'LOG-HOOD-M'),
  row('M / Black', 'Log Test Hoodie')::text,
  'And which piece: the product, its size and colour'
);

select is(
  (select order_number from public.v_log
    where kind = 'stock' and note = 'odd reference'),
  null,
  'A reference that is not an order id is left unresolved rather than failing'
);

select is(
  (select count(*)::int from public.v_log
    where kind = 'stock' and search_text ilike '%Log Customer%'),
  1,
  'Searching a customer''s name finds the piece sold to them'
);

select is(
  (select count(*)::int from public.v_log
    where kind = 'stock' and search_text ilike '%Joe the photographer%'),
  1,
  'And searching a name finds the pieces they have'
);

select is(
  (select count(*)::int from public.v_log
    where kind = 'order' and order_number = '#LOG-1' and search_text ilike '%#LOG-1%'),
  (select count(*)::int from public.order_events
    where order_id = 'a9a9a9a9-0000-0000-0000-0000000000a2'),
  'Every change to an order is in the log under its number'
);

select * from finish();
rollback;
