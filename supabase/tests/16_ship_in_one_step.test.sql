-- ---------------------------------------------------------------------------
-- Shipping: the shipment number and one tap books the courier; the parcel is
-- with them when they collect it (2026-10-24). Until then it is still here,
-- and an order can still be cancelled.
-- ---------------------------------------------------------------------------

begin;
select plan(27);

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
-- the old way and not yet collected; cancelled; one for our own driver; and
-- one the customer cancels before the courier comes.
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
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'cod',       400, 30,  400, null),
  ('f6f6f6f6-0000-0000-0000-0000000000a6', 'SHIP-CHANGED-MIND', 'dm',  'ready_to_pack',         'pending',
   'f6f6f6f6-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-0000000000c1', 'cod',       600, 50,  600, null);

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

-- --- The one tap: booked -----------------------------------------------------

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', '   ') $$,
  '22023', null,
  'It needs the shipment number'
);

select lives_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', ' ACC-SHIP-1 ') $$,
  'An order nobody has called or packed ships in one tap'
);

select set_config('request.jwt.claims', '', true);
reset role;

select is(
  (select fulfillment_status::text from public.orders where id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  'awaiting_pickup',
  'Booked: waiting for the courier, not yet with them'
);

select is(
  (select row(tracking_number, status::text, cod_amount_egp, handed_over_at is not null)::text
     from public.shipments where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  row('ACC-SHIP-1', 'awaiting_pickup', 1050.00::numeric(12, 2), false)::text,
  'The shipment carries the number and the amount to collect, and no handover yet'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'
      and from_fulfillment = 'awaiting_confirmation'
      and to_fulfillment = 'awaiting_pickup'
      and staff_id = 'f6f6f6f6-0000-0000-0000-00000000000d'),
  1,
  'The history records who shipped it'
);

select is(
  (select count(*)::int from public.v_courier_custody
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  0,
  'The courier does not have it yet, so their custody list does not count it'
);

select is(
  (select count(*)::int from public.v_packing_queue
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  1,
  'It stays on the packing screen, waiting for the courier'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f6f6f6f6-0000-0000-0000-00000000000d"}';

select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', 'ACC-SHIP-9');

select is(
  (select tracking_number from public.shipments where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  'ACC-SHIP-9',
  'A number typed wrong can be corrected while the parcel is still here'
);

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a2', 'ACC-SHIP-9') $$,
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
  row('ACC-SHIP-3', 'awaiting_pickup')::text,
  'It takes the number and waits for the courier'
);

-- --- The courier comes ---------------------------------------------------------

select is(
  (public.mark_picked_up(null, ' ACC-SHIP-9 ') ->> 'count')::int,
  1,
  'Scanning a label as the courier takes it marks that parcel collected'
);

select set_config('request.jwt.claims', '', true);
reset role;

select is(
  (select row(o.fulfillment_status::text, s.status::text, s.handed_over_at is not null)::text
     from public.orders o join public.shipments s on s.order_id = o.id
    where o.id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  row('in_transit', 'in_transit', true)::text,
  'Collected: with the courier, and the handover time is when they took it'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'
      and from_fulfillment = 'awaiting_pickup'
      and to_fulfillment = 'in_transit'
      and staff_id = 'f6f6f6f6-0000-0000-0000-00000000000d'),
  1,
  'The history records who handed it over'
);

select is(
  (select count(*)::int from public.v_courier_custody
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  1,
  'The courier custody list counts it from now'
);

select is(
  (select count(*)::int from public.v_packing_queue
    where order_id = 'f6f6f6f6-0000-0000-0000-0000000000a1'),
  0,
  'And it has left the packing screen'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f6f6f6f6-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a1', 'ACC-SHIP-10') $$,
  '23514', null,
  'A parcel the courier has cannot be shipped again'
);

select throws_ok(
  $$ select public.mark_picked_up(null, 'ACC-SHIP-9') $$,
  '23514', null,
  'Scanning a parcel already collected says so'
);

select throws_ok(
  $$ select public.mark_picked_up(null, 'NO-SUCH-PARCEL') $$,
  'P0002', null,
  'Scanning a label the CRM does not know says so'
);

select is(
  (public.mark_picked_up(array['f6f6f6f6-0000-0000-0000-0000000000a2', 'f6f6f6f6-0000-0000-0000-0000000000a3']::uuid[], null)
     ->> 'count')::int,
  2,
  'One tap marks every waiting parcel collected'
);

-- --- Cancelled before the courier comes ----------------------------------------

select public.ship_order('f6f6f6f6-0000-0000-0000-0000000000a6', 'ACC-SHIP-6');

select set_config('request.jwt.claims', '', true);
reset role;

select public.cancel_order('f6f6f6f6-0000-0000-0000-0000000000a6', 'Customer changed their mind');

select is(
  (select row(o.fulfillment_status::text, s.status::text)::text
     from public.orders o join public.shipments s on s.order_id = o.id
    where o.id = 'f6f6f6f6-0000-0000-0000-0000000000a6'),
  row('cancelled', 'cancelled')::text,
  'A booked parcel the customer cancels before pickup is cancelled, shipment and all'
);

select throws_ok(
  $$ select public.cancel_order('f6f6f6f6-0000-0000-0000-0000000000a1', null) $$,
  '23514', null,
  'Once the courier has it, it comes back through returns instead'
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
