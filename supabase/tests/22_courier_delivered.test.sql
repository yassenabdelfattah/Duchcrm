-- ---------------------------------------------------------------------------
-- Marking a courier parcel delivered: the customer has it, the courier still
-- has the cash.
-- ---------------------------------------------------------------------------

begin;
select plan(9);

insert into auth.users (id, email, aud, role) values
  ('fcfcfcfc-0000-0000-0000-00000000000c', 'deliv-sales@test.local', 'authenticated', 'authenticated');
update public.staff set role = 'sales', is_active = true where id = 'fcfcfcfc-0000-0000-0000-00000000000c';

insert into public.roles (id, name_ar, permissions)
values ('fcfcfcfc-0000-0000-0000-0000000000e1', 'عرض فقط تجريبي', array['orders.read']);
insert into auth.users (id, email, aud, role) values
  ('fcfcfcfc-0000-0000-0000-00000000000e', 'deliv-viewer@test.local', 'authenticated', 'authenticated');
update public.staff set role_id = 'fcfcfcfc-0000-0000-0000-0000000000e1', is_active = true
 where id = 'fcfcfcfc-0000-0000-0000-00000000000e';

insert into public.locations (id, name, type, is_default, is_active)
values ('fcfcfcfc-0000-0000-0000-000000000001', 'Deliv Shop', 'store', false, true);

insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('fcfcfcfc-0000-0000-0000-0000000000a1', 'DELIV-ACCURATE', 'dm', 'in_transit',       'pending',
   'fcfcfcfc-0000-0000-0000-000000000001', 'cod', 800, 60, 800),
  ('fcfcfcfc-0000-0000-0000-0000000000a2', 'DELIV-OWN',      'dm', 'out_for_delivery', 'pending',
   'fcfcfcfc-0000-0000-0000-000000000001', 'cod', 500, 50, 500),
  ('fcfcfcfc-0000-0000-0000-0000000000a3', 'DELIV-WAITING',  'dm', 'packed',           'pending',
   'fcfcfcfc-0000-0000-0000-000000000001', 'cod', 500, 50, 500);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at)
values ('fcfcfcfc-0000-0000-0000-0000000000a1', 'ACC-DELIV-1', 'outbound', 'in_transit', 860, now() - interval '3 days');
insert into public.shipments (order_id, courier, driver_name, direction, status, cod_amount_egp, handed_over_at)
values ('fcfcfcfc-0000-0000-0000-0000000000a2', 'own', 'Mahmoud', 'outbound', 'out_for_delivery', 550, now());

-- --- Who may ------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"fcfcfcfc-0000-0000-0000-00000000000e"}';

select throws_ok(
  $$ select public.mark_courier_delivered('fcfcfcfc-0000-0000-0000-0000000000a1') $$,
  '42501', null,
  'Someone who can only look at orders cannot record a delivery'
);

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"fcfcfcfc-0000-0000-0000-00000000000c"}';

-- --- The customer has it ------------------------------------------------------------

select lives_ok(
  $$ select public.mark_courier_delivered('fcfcfcfc-0000-0000-0000-0000000000a1') $$,
  'Sales staff mark an Accurate parcel delivered'
);

select is(
  (select row(fulfillment_status::text, payment_status::text)::text from public.orders
    where id = 'fcfcfcfc-0000-0000-0000-0000000000a1'),
  row('delivered', 'pending')::text,
  'Delivered, and still unpaid - the courier has the cash'
);

select is(
  (select row(status::text, delivered_at is not null)::text from public.shipments
    where order_id = 'fcfcfcfc-0000-0000-0000-0000000000a1'),
  row('delivered', true)::text,
  'The parcel is delivered, with when'
);

select is(
  (select stage from public.v_order_list where id = 'fcfcfcfc-0000-0000-0000-0000000000a1'),
  'delivered',
  'It moves to the delivered list, where an unpaid one counts as owed'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'fcfcfcfc-0000-0000-0000-0000000000a1'
      and to_fulfillment = 'delivered'
      and staff_id = 'fcfcfcfc-0000-0000-0000-00000000000c'),
  1,
  'The history records who said so'
);

select lives_ok(
  $$ select public.mark_courier_delivered('fcfcfcfc-0000-0000-0000-0000000000a1') $$,
  'A second tap is not an error'
);

-- --- Not for these -------------------------------------------------------------------

select throws_ok(
  $$ select public.mark_courier_delivered('fcfcfcfc-0000-0000-0000-0000000000a2') $$,
  '23514', null,
  'An order with our own driver is completed with the cash instead'
);

select throws_ok(
  $$ select public.mark_courier_delivered('fcfcfcfc-0000-0000-0000-0000000000a3') $$,
  '23514', null,
  'An order that has not gone out cannot be delivered'
);

select * from finish();
rollback;
