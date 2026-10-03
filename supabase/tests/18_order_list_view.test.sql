-- ---------------------------------------------------------------------------
-- The Orders screen's view: one row per order with its customer, the parcel
-- as it stands, what was bought, and where it is now since when.
-- ---------------------------------------------------------------------------

begin;
select plan(11);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('f8f8f8f8-0000-0000-0000-00000000000d', 'list-packing@test.local', 'authenticated', 'authenticated');
update public.staff set role = 'packing', is_active = true where id = 'f8f8f8f8-0000-0000-0000-00000000000d';

insert into public.locations (id, name, type, is_default, is_active)
values ('f8f8f8f8-0000-0000-0000-000000000001', 'List Shop', 'store', false, true);

insert into public.customers (id, full_name, phone, address_line1, address_line2, city, governorate)
values ('f8f8f8f8-0000-0000-0000-0000000000c1', 'List Customer', '01588877766', '12 Tahrir St', '  ', 'Dokki', 'Giza');

insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp, cancelled_at
) values
  ('f8f8f8f8-0000-0000-0000-0000000000a1', 'LIST-WAITING',  'dm', 'awaiting_confirmation', 'pending',
   'f8f8f8f8-0000-0000-0000-000000000001', 'f8f8f8f8-0000-0000-0000-0000000000c1', 'cod', 980, 70, 980, null),
  ('f8f8f8f8-0000-0000-0000-0000000000a2', 'LIST-ON-ROAD',  'dm', 'out_for_delivery',      'pending',
   'f8f8f8f8-0000-0000-0000-000000000001', 'f8f8f8f8-0000-0000-0000-0000000000c1', 'cod', 490, 50, 490, null),
  ('f8f8f8f8-0000-0000-0000-0000000000a3', 'LIST-CANCELLED','dm', 'cancelled',             'pending',
   'f8f8f8f8-0000-0000-0000-000000000001', 'f8f8f8f8-0000-0000-0000-0000000000c1', 'cod', 490, 50, 490, now()),
  ('f8f8f8f8-0000-0000-0000-0000000000a4', 'LIST-BACK',     'dm', 'returned',              'pending',
   'f8f8f8f8-0000-0000-0000-000000000001', 'f8f8f8f8-0000-0000-0000-0000000000c1', 'cod', 490, 50, 490, null);

insert into public.order_line_items (order_id, sku, title, variant_title, quantity, unit_price_egp, total_egp) values
  ('f8f8f8f8-0000-0000-0000-0000000000a1', 'LIST-A', 'List Sweatpant', 'L', 2, 245, 490),
  ('f8f8f8f8-0000-0000-0000-0000000000a1', 'LIST-B', 'List Hoodie',    'M', 1, 490, 490);

-- Our driver took it out three hours ago. A later Accurate shipment that was
-- called off must not be taken for where the parcel is.
insert into public.shipments (order_id, courier, driver_name, direction, status, cod_amount_egp, handed_over_at, created_at)
values ('f8f8f8f8-0000-0000-0000-0000000000a2', 'own', 'Mahmoud', 'outbound', 'out_for_delivery', 540,
        now() - interval '3 hours', now() - interval '3 hours');
insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, created_at)
values ('f8f8f8f8-0000-0000-0000-0000000000a2', 'LIST-CALLED-OFF', 'outbound', 'cancelled', 540, now());

-- --- Stages --------------------------------------------------------------------

select is(
  (select stage from public.v_order_list where order_number = 'LIST-WAITING'),
  'to_ship', 'An order nobody has shipped is waiting to ship'
);

select is(
  (select stage from public.v_order_list where order_number = 'LIST-ON-ROAD'),
  'on_the_road', 'One out with our driver is on the road'
);

select is(
  (select stage from public.v_order_list where order_number = 'LIST-CANCELLED'),
  'cancelled', 'A cancelled order is in its own list'
);

select is(
  (select stage from public.v_order_list where order_number = 'LIST-BACK'),
  'back', 'A returned order is back'
);

-- --- The parcel as it stands -------------------------------------------------------

select is(
  (select row(courier, driver_name, tracking_number)::text from public.v_order_list where order_number = 'LIST-ON-ROAD'),
  row('own', 'Mahmoud', null::text)::text,
  'A shipment that was called off is not where the order is'
);

select ok(
  (select abs(extract(epoch from (stage_since - (now() - interval '3 hours')))) < 5
     from public.v_order_list where order_number = 'LIST-ON-ROAD'),
  'On the road counts from the handover'
);

-- --- What they bought, and who to -------------------------------------------------------

select is(
  (select row(jsonb_array_length(items), unit_count)::text from public.v_order_list where order_number = 'LIST-WAITING'),
  row(2, 3)::text,
  'Both lines are there, three pieces in all'
);

select is(
  (select customer_address from public.v_order_list where order_number = 'LIST-WAITING'),
  '12 Tahrir St، Dokki، Giza',
  'The address reads as one line, skipping a blank part'
);

select is(
  (select count(*)::int from public.v_order_list
    where order_number like 'LIST-%' and customer_phone ilike '%8887%'),
  4,
  'Orders can be found by part of the phone number'
);

-- --- Who can read it ------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f8f8f8f8-0000-0000-0000-00000000000d"}';

select is(
  (select count(*)::int from public.v_order_list where order_number like 'LIST-%'),
  4,
  'Any active staff member can read the list'
);

select set_config('request.jwt.claims', '', true);
set local role anon;

select throws_ok(
  $$ select count(*) from public.v_order_list $$,
  '42501', null,
  'Nobody signed out can'
);

select * from finish();
rollback;
