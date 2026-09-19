-- ---------------------------------------------------------------------------
-- Bringing Shopify orders into the CRM.
--
-- The things that matter here are that a replayed webhook does not sell the
-- same stock twice, that an order containing something we do not recognise is
-- still imported rather than rejected, and that a cancellation in Shopify
-- cannot magic a parcel back out of a van.
-- ---------------------------------------------------------------------------

begin;
select plan(20);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active, shopify_location_id)
values ('c3c3c3c3-0000-0000-0000-000000000001', 'Web Test Warehouse', 'warehouse', true, true, 55501);

insert into public.products (id, title)
values ('c3c3c3c3-0000-0000-0000-000000000002', 'Web Test Hoodie');

insert into public.variants (id, product_id, sku, size, price_egp, shopify_variant_id)
values
  ('c3c3c3c3-0000-0000-0000-000000000003', 'c3c3c3c3-0000-0000-0000-000000000002',
   'WEB-HOOD-M', 'M', 1500.00, 77701),
  ('c3c3c3c3-0000-0000-0000-000000000004', 'c3c3c3c3-0000-0000-0000-000000000002',
   'WEB-HOOD-L', 'L', 1500.00, null);

select public.record_stock_movements(
  'c3c3c3c3-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"c3c3c3c3-0000-0000-0000-000000000003","quantity_delta":10},
    {"variant_id":"c3c3c3c3-0000-0000-0000-000000000004","quantity_delta":10}]'::jsonb
);

-- A realistic webhook body, shaped the way Shopify actually sends one.
create or replace function pg_temp.web_order(
  p_id        bigint,
  p_items     jsonb,
  p_financial text default 'pending',
  p_gateway   text default 'Cash on Delivery (COD)'
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id,
    'order_number', p_id % 10000,
    'name', '#' || (p_id % 10000)::text,
    'email', 'nour@example.com',
    'phone', '+20 100 123 4567',
    'currency', 'EGP',
    'financial_status', p_financial,
    'total_discounts', '0.00',
    'payment_gateway_names', jsonb_build_array(p_gateway),
    'total_shipping_price_set', jsonb_build_object(
      'shop_money', jsonb_build_object('amount', '70.00', 'currency_code', 'EGP')
    ),
    'customer', jsonb_build_object(
      'id', 900001, 'email', 'nour@example.com',
      'first_name', 'Nour', 'last_name', 'Ahmed'
    ),
    'shipping_address', jsonb_build_object(
      'first_name', 'Nour', 'last_name', 'Ahmed',
      'address1', '12 Road 9', 'city', 'Maadi', 'province', 'Cairo',
      'phone', '+20 100 123 4567'
    ),
    'line_items', p_items
  );
$$;

-- --- A normal order --------------------------------------------------------

select lives_ok(
  $$ select public.ingest_shopify_order(pg_temp.web_order(
       5001,
       jsonb_build_array(jsonb_build_object(
         'id', 1, 'variant_id', 77701, 'sku', 'WEB-HOOD-M',
         'title', 'Web Test Hoodie - M', 'quantity', 2,
         'price', '1500.00', 'total_discount', '0.00'
       ))
     )) $$,
  'A storefront order is imported'
);

select is(
  (select fulfillment_status::text from public.orders where shopify_order_id = 5001),
  'awaiting_confirmation',
  'It lands in the confirmation queue, not straight into packing'
);

select is(
  (select payment_status::text from public.orders where shopify_order_id = 5001),
  'pending',
  'Cash on delivery has not been collected, so it is unpaid'
);

select is(
  (select payment_method::text from public.orders where shopify_order_id = 5001),
  'cod',
  'The gateway name was read as cash on delivery'
);

select is(
  (select shipping_egp from public.orders where shopify_order_id = 5001),
  70.00::numeric,
  'Shipping was picked out of the money set'
);

select is(
  (select total_egp from public.orders where shopify_order_id = 5001),
  3000.00::numeric,
  'The goods total is two units at the line price'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'c3c3c3c3-0000-0000-0000-000000000003'),
  8,
  'Stock came off the moment the order arrived'
);

-- --- The customer ----------------------------------------------------------

select is(
  (select phone from public.customers where shopify_customer_id = 900001),
  '01001234567',
  'The phone number was normalised, so this customer can be matched across channels'
);

select is(
  (select governorate from public.customers where shopify_customer_id = 900001),
  'Cairo',
  'The delivery governorate was captured, which is what return rates get sliced by'
);

-- --- Shopify redelivers ----------------------------------------------------

select is(
  (select (public.ingest_shopify_order(pg_temp.web_order(
     5001,
     jsonb_build_array(jsonb_build_object(
       'id', 1, 'variant_id', 77701, 'sku', 'WEB-HOOD-M',
       'title', 'Web Test Hoodie - M', 'quantity', 2,
       'price', '1500.00', 'total_discount', '0.00'
     ))
   ))).id),
  (select id from public.orders where shopify_order_id = 5001),
  'A redelivered webhook returns the order that already exists'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'c3c3c3c3-0000-0000-0000-000000000003'),
  8,
  'And does not take the stock a second time'
);

select is(
  (select count(*)::int from public.orders where shopify_order_id = 5001),
  1,
  'There is still exactly one order'
);

-- --- A variant with no Shopify id, matched by SKU --------------------------

select public.ingest_shopify_order(pg_temp.web_order(
  5002,
  jsonb_build_array(jsonb_build_object(
    'id', 2, 'variant_id', null, 'sku', 'WEB-HOOD-L',
    'title', 'Web Test Hoodie - L', 'quantity', 1,
    'price', '1500.00', 'total_discount', '0.00'
  ))
));

select is(
  (select variant_id from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where o.shopify_order_id = 5002),
  'c3c3c3c3-0000-0000-0000-000000000004'::uuid,
  'A line with no Shopify variant id still matched on SKU'
);

-- --- Something we have never seen ------------------------------------------
--
-- The customer has bought it either way. An order we refuse to import is an
-- order nobody packs.

select public.ingest_shopify_order(pg_temp.web_order(
  5003,
  jsonb_build_array(jsonb_build_object(
    'id', 3, 'variant_id', 999999, 'sku', 'NOT-IN-CRM',
    'title', 'Mystery Item', 'quantity', 1,
    'price', '900.00', 'total_discount', '0.00'
  ))
));

select is(
  (select count(*)::int from public.orders where shopify_order_id = 5003),
  1,
  'An order containing an unknown item is still imported'
);

select is(
  (select variant_id from public.order_line_items li
     join public.orders o on o.id = li.order_id
    where o.shopify_order_id = 5003),
  null,
  'The unmatched line is recorded with no variant rather than dropped'
);

select isnt_empty(
  $$ select id from public.sync_issues
      where type = 'missing_in_crm'
        and details ->> 'reason' = 'order_contains_unknown_variants' $$,
  'And it is raised as a sync issue for someone to fix in Shopify'
);

-- --- Cancelled in Shopify --------------------------------------------------

select public.cancel_shopify_order(5002, 'Customer changed their mind');

select is(
  (select fulfillment_status::text from public.orders where shopify_order_id = 5002),
  'cancelled',
  'A Shopify cancellation cancels the CRM order'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'c3c3c3c3-0000-0000-0000-000000000004'),
  10,
  'And puts the stock back, because it never left the building'
);

-- --- Cancelled after it shipped --------------------------------------------

update public.orders set fulfillment_status = 'in_transit' where shopify_order_id = 5001;

select public.cancel_shopify_order(5001, 'Cancelled in Shopify');

select is(
  (select fulfillment_status::text from public.orders where shopify_order_id = 5001),
  'in_transit',
  'Cancelling in Shopify cannot pull a parcel back out of a van'
);

select isnt_empty(
  $$ select id from public.sync_issues
      where details ->> 'reason' = 'shopify_cancelled_an_order_already_shipped' $$,
  'It is flagged for a person to recall the parcel instead'
);

select * from finish();
rollback;
