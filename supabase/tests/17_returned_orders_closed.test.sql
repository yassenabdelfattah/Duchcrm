-- ---------------------------------------------------------------------------
-- A returned order is closed: nothing is owed on it, and its money and items
-- cannot change. Found on S2609-00015, marked paid after it came back.
-- ---------------------------------------------------------------------------

begin;
select plan(9);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('f7f7f7f7-0000-0000-0000-00000000000c', 'closed-sales@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'sales', is_active = true where id = 'f7f7f7f7-0000-0000-0000-00000000000c';

insert into public.locations (id, name, type, is_default, is_active)
values ('f7f7f7f7-0000-0000-0000-000000000001', 'Closed Shop', 'store', false, true);

insert into public.customers (id, full_name, phone, governorate)
values ('f7f7f7f7-0000-0000-0000-0000000000c1', 'Closed Customer', '01599955566', 'Cairo');

insert into public.products (id, title)
values ('f7f7f7f7-0000-0000-0000-000000000002', 'Closed Slipper');

insert into public.variants (id, product_id, sku, price_egp)
values ('f7f7f7f7-0000-0000-0000-000000000003', 'f7f7f7f7-0000-0000-0000-000000000002', 'CLOSED-42', 500);

-- A shop sale on cash on delivery that came back, one on its way back, and
-- an ordinary delivered one still owing.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('f7f7f7f7-0000-0000-0000-0000000000a1', 'CLOSED-RETURNED', 'store', 'returned',          'pending',
   'f7f7f7f7-0000-0000-0000-000000000001', 'f7f7f7f7-0000-0000-0000-0000000000c1', 'cod', 500, 0, 500),
  ('f7f7f7f7-0000-0000-0000-0000000000a2', 'CLOSED-COMING',   'dm',    'return_in_transit', 'pending',
   'f7f7f7f7-0000-0000-0000-000000000001', 'f7f7f7f7-0000-0000-0000-0000000000c1', 'cod', 500, 50, 500),
  ('f7f7f7f7-0000-0000-0000-0000000000a3', 'OPEN-DELIVERED',  'dm',    'delivered',         'pending',
   'f7f7f7f7-0000-0000-0000-000000000001', 'f7f7f7f7-0000-0000-0000-0000000000c1', 'deferred', 500, 0, 500);

insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
values ('f7f7f7f7-0000-0000-0000-0000000000a1', 'f7f7f7f7-0000-0000-0000-000000000003', 'CLOSED-42', 'Closed Slipper', 1, 500, 500);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f7f7f7f7-0000-0000-0000-00000000000c"}';

-- --- Nothing owed -------------------------------------------------------------

select throws_ok(
  $$ select public.mark_order_paid('f7f7f7f7-0000-0000-0000-0000000000a1') $$,
  '23514', null,
  'A returned order cannot be marked paid'
);

select is(
  (select payment_status::text from public.orders where id = 'f7f7f7f7-0000-0000-0000-0000000000a1'),
  'pending',
  'Its payment is left alone, so a courier statement line can still be expected'
);

select throws_ok(
  $$ select public.mark_order_paid('f7f7f7f7-0000-0000-0000-0000000000a2') $$,
  '23514', null,
  'Nor one on its way back'
);

select lives_ok(
  $$ select public.mark_order_paid('f7f7f7f7-0000-0000-0000-0000000000a3') $$,
  'A delivered order that is still owed can be'
);

-- --- Money and items closed, note open ------------------------------------------

select throws_ok(
  $$ select public.update_order_details('f7f7f7f7-0000-0000-0000-0000000000a1', p_shipping_egp => 60) $$,
  '23514', null,
  'A returned order''s money cannot be edited'
);

select throws_ok(
  $$ select public.update_order_items(
       'f7f7f7f7-0000-0000-0000-0000000000a1',
       '[{"variant_id":"f7f7f7f7-0000-0000-0000-000000000003","quantity":2}]'::jsonb) $$,
  '23514', null,
  'Nor its items - that would move stock the return already put back'
);

select is(
  (select count(*)::int from public.stock_movements
    where variant_id = 'f7f7f7f7-0000-0000-0000-000000000003'),
  0,
  'No stock moved'
);

select lives_ok(
  $$ select public.update_order_details('f7f7f7f7-0000-0000-0000-0000000000a1', p_note => 'Customer changed their mind') $$,
  'The note can still be corrected'
);

select is(
  (select note from public.orders where id = 'f7f7f7f7-0000-0000-0000-0000000000a1'),
  'Customer changed their mind',
  'And it is saved'
);

select * from finish();
rollback;
