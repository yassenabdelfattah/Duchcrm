-- ---------------------------------------------------------------------------
-- Taking back "delivered" pressed by mistake.
--
-- What matters: the order and its shipment go back to where they were, with
-- the courier or out with our driver, and the history says who and why;
-- Accurate's statement saying it came back (#1472) does not stop it; and it
-- stops where something was built on the delivery - paid with it, a piece
-- back, or the statement saying the customer has it.
-- ---------------------------------------------------------------------------

begin;
select plan(17);

insert into auth.users (id, email, aud, role) values
  ('fdfdfdfd-0000-0000-0000-00000000000c', 'undo-sales@test.local', 'authenticated', 'authenticated');
update public.staff set role = 'sales', is_active = true where id = 'fdfdfdfd-0000-0000-0000-00000000000c';

insert into public.roles (id, name_ar, permissions)
values ('fdfdfdfd-0000-0000-0000-0000000000e1', 'عرض فقط للتراجع', array['orders.read']);
insert into auth.users (id, email, aud, role) values
  ('fdfdfdfd-0000-0000-0000-00000000000e', 'undo-viewer@test.local', 'authenticated', 'authenticated');
update public.staff set role_id = 'fdfdfdfd-0000-0000-0000-0000000000e1', is_active = true
 where id = 'fdfdfdfd-0000-0000-0000-00000000000e';

insert into public.locations (id, name, type, is_default, is_active)
values ('fdfdfdfd-0000-0000-0000-000000000001', 'Undo Shop', 'store', false, true);

-- A1 #1472's shape; A2 our driver, cash; A3 our driver, on the tab; A4 paid
-- online before it left; A5 marked paid after; A6 on a statement as
-- delivered; A7 a piece back; A8 sold over the counter.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('fdfdfdfd-0000-0000-0000-0000000000a1', 'UNDO-ACCURATE', 'online', 'in_transit',       'pending',
   'fdfdfdfd-0000-0000-0000-000000000001', 'cod', 820, 80, 820),
  ('fdfdfdfd-0000-0000-0000-0000000000a2', 'UNDO-OWN-CASH', 'dm',     'out_for_delivery', 'pending',
   'fdfdfdfd-0000-0000-0000-000000000001', 'cod', 500, 50, 500),
  ('fdfdfdfd-0000-0000-0000-0000000000a3', 'UNDO-OWN-TAB',  'dm',     'out_for_delivery', 'pending',
   'fdfdfdfd-0000-0000-0000-000000000001', 'deferred', 500, 50, 500),
  ('fdfdfdfd-0000-0000-0000-0000000000a4', 'UNDO-PREPAID',  'online', 'in_transit',       'paid',
   'fdfdfdfd-0000-0000-0000-000000000001', 'card', 700, 0, 700),
  ('fdfdfdfd-0000-0000-0000-0000000000a5', 'UNDO-PAID-AFTER', 'online', 'in_transit',     'pending',
   'fdfdfdfd-0000-0000-0000-000000000001', 'cod', 700, 80, 700),
  ('fdfdfdfd-0000-0000-0000-0000000000a6', 'UNDO-ON-STATEMENT', 'online', 'in_transit',   'pending',
   'fdfdfdfd-0000-0000-0000-000000000001', 'cod', 700, 80, 700),
  ('fdfdfdfd-0000-0000-0000-0000000000a8', 'UNDO-COUNTER',  'store',  'delivered',        'pending',
   'fdfdfdfd-0000-0000-0000-000000000001', 'deferred', 300, 0, 300);

insert into public.shipments (order_id, courier, driver_name, tracking_number, direction, status, cod_amount_egp, handed_over_at)
values
  ('fdfdfdfd-0000-0000-0000-0000000000a1', 'accurate', null, 'UNDO-ACC-1', 'outbound', 'in_transit', 900, now() - interval '5 days'),
  ('fdfdfdfd-0000-0000-0000-0000000000a2', 'own', 'Mahmoud', null, 'outbound', 'out_for_delivery', 550, now()),
  ('fdfdfdfd-0000-0000-0000-0000000000a3', 'own', 'Mahmoud', null, 'outbound', 'out_for_delivery', 550, now()),
  ('fdfdfdfd-0000-0000-0000-0000000000a4', 'accurate', null, 'UNDO-ACC-4', 'outbound', 'in_transit', 0, now() - interval '3 days'),
  ('fdfdfdfd-0000-0000-0000-0000000000a5', 'accurate', null, 'UNDO-ACC-5', 'outbound', 'in_transit', 780, now() - interval '3 days'),
  ('fdfdfdfd-0000-0000-0000-0000000000a6', 'accurate', null, 'UNDO-ACC-6', 'outbound', 'in_transit', 780, now() - interval '3 days');

-- Delivered, each the way it happens.
select public.mark_courier_delivered(id)
  from public.orders where id in ('fdfdfdfd-0000-0000-0000-0000000000a1', 'fdfdfdfd-0000-0000-0000-0000000000a4',
                                  'fdfdfdfd-0000-0000-0000-0000000000a5', 'fdfdfdfd-0000-0000-0000-0000000000a6');
select public.complete_own_delivery('fdfdfdfd-0000-0000-0000-0000000000a2');
select public.complete_own_delivery('fdfdfdfd-0000-0000-0000-0000000000a3');
select public.mark_order_paid('fdfdfdfd-0000-0000-0000-0000000000a5');

-- Accurate's statement: #1472's came back, A6 was delivered.
insert into public.courier_settlements (id, reference)
values ('fdfdfdfd-0000-0000-0000-0000000000f1', 'UNDO-STATEMENT');
insert into public.settlement_lines (settlement_id, order_id, outcome, collected_egp, fee_egp)
values
  ('fdfdfdfd-0000-0000-0000-0000000000f1', 'fdfdfdfd-0000-0000-0000-0000000000a1', 'returned_other', 0, 0),
  ('fdfdfdfd-0000-0000-0000-0000000000f1', 'fdfdfdfd-0000-0000-0000-0000000000a6', 'delivered', 780, 70);

-- --- Who may ------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"fdfdfdfd-0000-0000-0000-00000000000e"}';

select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'Someone who can only look at orders cannot take a delivery back');

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"fdfdfdfd-0000-0000-0000-00000000000c"}';

-- --- #1472: delivered by mistake, and Accurate says it came back --------------

select lives_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a1', 'Pressed on the wrong order') $$,
  'Whoever can mark a courier parcel delivered can take it back - a statement saying it came back is no obstacle');

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select row(o.fulfillment_status, s.status, s.delivered_at)::text
     from public.orders o join public.shipments s on s.order_id = o.id
    where o.id = 'fdfdfdfd-0000-0000-0000-0000000000a1'),
  row('in_transit', 'in_transit', null)::text,
  'The order and its shipment are back with the courier, with no delivery date');
select is(
  (select row(e.note, e.details ->> 'back_to', e.staff_id)::text from public.order_events e
    where e.order_id = 'fdfdfdfd-0000-0000-0000-0000000000a1' and e.event_type = 'delivery_undone'),
  row('Pressed on the wrong order', 'in_transit', 'fdfdfdfd-0000-0000-0000-00000000000c')::text,
  'The history says it was taken back, why, and by whom');
select is(
  (select mismatch from public.v_settlement_statement where order_id = 'fdfdfdfd-0000-0000-0000-0000000000a1'),
  'not_back', 'The statement now asks for it to be checked in on Returns, not that the CRM says delivered');
select is(
  (select stage from public.v_order_list where id = 'fdfdfdfd-0000-0000-0000-0000000000a1'),
  'on_the_road', 'It is on the road again, and no longer owed by the courier');

select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a1') $$,
  '23514', null, 'Taking it back twice is refused: it is not delivered');

-- --- Our driver ----------------------------------------------------------------

select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a2') $$,
  '23514', 'Order UNDO-OWN-CASH was paid on delivery: reopen its payment first',
  '"Cash received" paid it with the delivery: the payment is reopened first');

select lives_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a3') $$,
  'Delivered by our driver on the tab: taken back');
select is(
  (select row(o.fulfillment_status, s.status, s.driver_name)::text
     from public.orders o join public.shipments s on s.order_id = o.id
    where o.id = 'fdfdfdfd-0000-0000-0000-0000000000a3'),
  row('out_for_delivery', 'out_for_delivery', 'Mahmoud')::text,
  'and it is out with the same driver again');

-- --- Paid, before and after ---------------------------------------------------

select lives_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a4') $$,
  'Paid online before it left: the payment is not the delivery''s, and it is taken back');
select is((select payment_status::text from public.orders where id = 'fdfdfdfd-0000-0000-0000-0000000000a4'),
  'paid', 'and stays paid');

select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a5') $$,
  '23514', 'Order UNDO-PAID-AFTER was paid on delivery: reopen its payment first',
  'Marked paid after the delivery: the payment is reopened first');

-- --- What the delivery built ----------------------------------------------------

select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a6') $$,
  '23514', 'The courier''s statement says order UNDO-ON-STATEMENT was delivered',
  'Accurate''s statement says the customer has it: not taken back');

insert into public.returns (order_id, type, status)
values ('fdfdfdfd-0000-0000-0000-0000000000a4', 'post_delivery', 'expected');
select public.mark_courier_delivered('fdfdfdfd-0000-0000-0000-0000000000a4');
select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a4') $$,
  '23514', 'Order UNDO-PREPAID has pieces back from the customer',
  'A piece back from the customer: the return is the record now');

select throws_ok(
  $$ select public.undo_delivered('fdfdfdfd-0000-0000-0000-0000000000a8') $$,
  '23514', 'Order UNDO-COUNTER was never sent out',
  'Sold over the counter: nothing to take back');

select is(
  (select count(*)::int from public.order_events
    where order_id = 'fdfdfdfd-0000-0000-0000-0000000000a6' and event_type = 'delivery_undone'),
  0, 'A refusal leaves nothing behind');

select * from finish();
rollback;
