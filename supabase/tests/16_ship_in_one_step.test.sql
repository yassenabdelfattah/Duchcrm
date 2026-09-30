-- ---------------------------------------------------------------------------
-- Shipping in one step: the shipment number, one tap, and the parcel is with
-- the courier - from wherever the order was waiting.
-- ---------------------------------------------------------------------------

begin;
select plan(16);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('f6f6f6f6-0000-0000-0000-00000000000c', 'ship-sales@test.local',   'authenticated', 'authenticated'),
  ('f6f6f6f6-0000-0000-0000-00000000000d', 'ship-packing@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'sales',   is_active = true where id = 'f6f6f6f6-0000-0000-0000-00000000000c';
update public.staff set role = 'packing', is_active = true where id = 'f6f6f6f6-0000-0000-0000-00000000000d';

insert into public.locations (id, name, type, is_default, is_active)
values ('f6f6f6f6-0000-0000-0000-000000000001', 'Ship Shop', 'store', false, true);

insert into public.customers (id, full_name, phone, governorate)
values ('f6f6f6f6-0000-0000-0000-0000000000c1', 'Ship Customer', '01599933344', 'Giza');

-- Just in and not yet called; prepaid and waiting to pack; a shipment made
-- the old way and not yet collected; cancelled; and one for our own driver.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp, cancelled_at
) values
  ('f6f6f6f6-0000-0000-0000-0000000000a1', 'SHIP-NEW',       'online', 'awaiting_confirmation', 'pending',
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'cod',      1000, 50, 1000, null),
  ('f6f6f6f6-0000-0000-0000-0000000000a2', 'SHIP-PREPAID',   'dm',     'ready_to_pack',         'paid',
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'instapay',  800, 50,  800, null),
  ('f6f6f6f6-0000-0000-0000-0000000000a3', 'SHIP-OLDWAY',    'dm',     'awaiting_pickup',       'pending',
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'cod',       700, 50,  700, null),
  ('f6f6f6f6-0000-0000-0000-0000000000a4', 'SHIP-CANCELLED', 'dm',     'cancelled',             'pending',
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'cod',       500, 50,  500, now()),
  ('f6f6f6f6-0000-0000-0000-0000000000a5', 'SHIP-OWN',       'dm',     'awaiting_confirmation', 'pending',
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'cod',       400, 30,  400, null);

insert into public.shipments (order_id, direction, status, cod_amount_egp)
values ('f6f6f6f6-0000-0000-0000-0000000000a3', 'outbound', 'awaiting_pickup', 750);

-- --- Only people who ship ----------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f6f6f6f6-0000-0000-0000-00000000000c"}';

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', 'ACC-SHIP-1') $$,
  '42501', null,
  'A sales user cannot ship'
);

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f6f6f6f6-0000-0000-0000-00000000000d"}';

-- --- The one step ------------------------------------------------------------

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', '   ') $$,
  '22023', null,
  'It needs the shipment number'
);

select lives_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', ' ACC-SHIP-1 ') $$,
  'An order nobody has called or packed ships in one step'
);

select set_config('request.jwt.claims', '', true);
reset role;

select is(
  (select fulfillment_status::text from public.orders where id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  'in_transit',
  'It is out with the courier'
);

select is(
  (select row(tracking_number, status::text, cod_amount_egp, handed_over_at is not null)::text
     from public.shipments where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  row('ACC-SHIP-1', 'in_transit', 1050.00::numeric(12, 2), true)::text,
  'The shipment carries the number, the amount to collect, and the handover time'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'
      and from_fulfillment = 'awaiting_confirmation'
      and to_fulfillment = 'in_transit'
      and staff_id = 'f6f6f6f6-0000-0000-0000-00000000000d'),
  1,
  'The history records who shipped it'
);

select is(
  (select count(*)::int from public.v_courier_custody
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  1,
  'The courier custody list now counts it'
);

select is(
  (select count(*)::int from public.v_packing_queue
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  0,
  'And it has left the packing queue'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f6f6f6f6-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', 'ACC-SHIP-9') $$,
  '23514', null,
  'An order already out cannot be shipped again'
);

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a2', 'ACC-SHIP-1') $$,
  '23505', null,
  'A shipment number already used on another parcel is refused'
);

select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a2', 'ACC-SHIP-2');

select is(
  (select cod_amount_egp from public.shipments where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a2'),
  0.00::numeric(12, 2),
  'A prepaid order has nothing to collect'
);

-- --- A shipment made the old way ---------------------------------------------

select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a3', 'ACC-SHIP-3');

select is(
  (select count(*)::int from public.shipments where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a3'),
  1,
  'Shipping an order that already had a shipment uses it rather than adding one'
);

select is(
  (select row(tracking_number, status::text)::text from public.shipments
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a3'),
  row('ACC-SHIP-3', 'in_transit')::text,
  'It takes the number and goes out'
);

-- --- Never a cancelled order -------------------------------------------------

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a4', 'ACC-SHIP-4') $$,
  '23514', null,
  'A cancelled order cannot ship'
);

-- --- Our own driver, also in one step ----------------------------------------

select lives_ok(
  $$ select public.start_own_delivery('f6f6f6f6-0000-0000-0000-0000000000a5', 'Mahmoud') $$,
  'An order nobody has called or packed can go with our driver'
);

select is(
  (select fulfillment_status::text from public.orders where id = 'f6f6f6f6-0000-0000-0000-0000000000a5'),
  'out_for_delivery',
  'It is out with our driver'
);

select * from finish();
rollback;
