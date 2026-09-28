-- ---------------------------------------------------------------------------
-- Delivering with our own driver, the returns list, and closing a stale
-- "no SKU" issue.
--
-- The money rule is the one that matters: cash on delivery is paid only when
-- our driver hands it in, only through complete_own_delivery, and
-- mark_order_paid still refuses it.
-- ---------------------------------------------------------------------------

begin;
select plan(24);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('f1f1f1f1-0000-0000-0000-00000000000a', 'own-admin@test.local',   'authenticated', 'authenticated'),
  ('f1f1f1f1-0000-0000-0000-00000000000c', 'own-sales@test.local',   'authenticated', 'authenticated'),
  ('f1f1f1f1-0000-0000-0000-00000000000d', 'own-packing@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'admin',   is_active = true where id = 'f1f1f1f1-0000-0000-0000-00000000000a';
update public.staff set role = 'sales',   is_active = true where id = 'f1f1f1f1-0000-0000-0000-00000000000c';
update public.staff set role = 'packing', is_active = true where id = 'f1f1f1f1-0000-0000-0000-00000000000d';

insert into public.locations (id, name, type, is_default, is_active)
values ('f1f1f1f1-0000-0000-0000-000000000001', 'Own Delivery Shop', 'store', false, true);

insert into public.customers (id, full_name, phone, governorate)
values ('f1f1f1f1-0000-0000-0000-0000000000c1', 'Own Delivery Customer', '01599911122', 'Cairo');

-- A packed cash-on-delivery order, a packed paying-later order, an order not
-- yet packed, and a packed order that already went with Accurate.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('f1f1f1f1-0000-0000-0000-0000000000a1', 'OWN-COD',      'dm', 'packed',        'pending',
   'f1f1f1f1-0000-0000-0000-000000000001', 'f1f1f1f1-0000-0000-0000-0000000000c1', 'cod',      1000, 50, 1000),
  ('f1f1f1f1-0000-0000-0000-0000000000a2', 'OWN-DEFERRED', 'dm', 'packed',        'pending',
   'f1f1f1f1-0000-0000-0000-000000000001', 'f1f1f1f1-0000-0000-0000-0000000000c1', 'deferred', 800, 0, 800),
  ('f1f1f1f1-0000-0000-0000-0000000000a3', 'OWN-NOTPACKED','dm', 'ready_to_pack', 'pending',
   'f1f1f1f1-0000-0000-0000-000000000001', 'f1f1f1f1-0000-0000-0000-0000000000c1', 'cod',      500, 50, 500),
  ('f1f1f1f1-0000-0000-0000-0000000000a4', 'OWN-ACCURATE', 'dm', 'awaiting_pickup','pending',
   'f1f1f1f1-0000-0000-0000-000000000001', 'f1f1f1f1-0000-0000-0000-0000000000c1', 'cod',      700, 50, 700);

insert into public.order_line_items (order_id, sku, title, quantity, unit_price_egp, total_egp) values
  ('f1f1f1f1-0000-0000-0000-0000000000a1', 'OWN-HOOD', 'Own Hoodie', 1, 1000, 1000),
  ('f1f1f1f1-0000-0000-0000-0000000000a2', 'OWN-TEE',  'Own Tee',    1,  800,  800);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp)
values ('f1f1f1f1-0000-0000-0000-0000000000a4', 'ACC-OWN-TEST', 'outbound', 'awaiting_pickup', 750);

-- --- Step one: only packing-side roles send it out --------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1f1f1f1-0000-0000-0000-00000000000c"}';

select throws_ok(
  $$ select public.start_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a1', 'Mahmoud') $$,
  '42501', null,
  'A sales user cannot send an order out'
);

reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1f1f1f1-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.start_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a1', '   ') $$,
  '22023', null,
  'It has to say who is delivering'
);

select throws_ok(
  $$ select public.start_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a3', 'Mahmoud') $$,
  '23514', null,
  'An order that is not packed cannot go out'
);

select lives_ok(
  $$ select public.start_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a1', ' Mahmoud ') $$,
  'A packing user sends a packed order out with our own driver'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select fulfillment_status::text from public.orders where id = 'f1f1f1f1-0000-0000-0000-0000000000a1'),
  'out_for_delivery',
  'The order is out for delivery'
);

select results_eq(
  $$ select courier, driver_name, cod_amount_egp, tracking_number is null
       from public.shipments where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' $$,
  $$ values ('own'::text, 'Mahmoud'::text, 1050.00::numeric(12,2), true) $$,
  'With our driver, no tracking code, collecting goods plus shipping'
);

select is(
  (select driver_name from public.v_packing_queue where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1'),
  'Mahmoud',
  'It stays on the packing queue, showing who holds the cash'
);

select is_empty(
  $$ select 1 from public.v_courier_custody where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' $$,
  'It is not counted as with the courier'
);

select throws_ok(
  $$ select public.mark_order_paid('f1f1f1f1-0000-0000-0000-0000000000a1') $$,
  '23001', null,
  'Mark paid still refuses cash on delivery - the cash is with the driver, not us'
);

-- --- Step two: only the people who settle money record it ------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1f1f1f1-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.complete_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a1') $$,
  '42501', null,
  'A packing user cannot record the cash as received'
);

reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1f1f1f1-0000-0000-0000-00000000000c"}';

select lives_ok(
  $$ select public.complete_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a1') $$,
  'A sales user records the delivery once the driver hands the cash in'
);

select lives_ok(
  $$ select public.complete_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a1') $$,
  'A second tap is not an error'
);

reset role;
select set_config('request.jwt.claims', '', true);

select results_eq(
  $$ select fulfillment_status::text, payment_status::text
       from public.orders where id = 'f1f1f1f1-0000-0000-0000-0000000000a1' $$,
  $$ values ('delivered'::text, 'paid'::text) $$,
  'Cash on delivery is now delivered and paid'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1'
      and to_payment = 'paid'),
  1,
  'Paid was recorded once, not once per tap'
);

select is(
  (select staff_id from public.order_events
    where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' and to_payment = 'paid'),
  'f1f1f1f1-0000-0000-0000-00000000000c'::uuid,
  'With the name of whoever recorded it'
);

select is_empty(
  $$ select 1 from public.v_packing_queue where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' $$,
  'It leaves the packing queue'
);

select isnt_empty(
  $$ select 1 from public.v_returnable_orders where order_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' $$,
  'And is offered on the returns list, in case the customer brings it back'
);

-- --- A paying-later order delivered by us still owes the money --------------

select public.start_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a2', 'Mahmoud');
select public.complete_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a2');

select results_eq(
  $$ select fulfillment_status::text, payment_status::text
       from public.orders where id = 'f1f1f1f1-0000-0000-0000-0000000000a2' $$,
  $$ values ('delivered'::text, 'pending'::text) $$,
  'Delivering a paying-later order does not mark it paid'
);

-- --- Only our own deliveries ------------------------------------------------

select throws_ok(
  $$ select public.complete_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a4') $$,
  '23514', null,
  'An order that went with Accurate is settled by its statement, not here'
);

-- --- Refused at the door ----------------------------------------------------

update public.orders set fulfillment_status = 'packed'
 where id = 'f1f1f1f1-0000-0000-0000-0000000000a3';
insert into public.order_line_items (order_id, sku, title, quantity, unit_price_egp, total_egp)
values ('f1f1f1f1-0000-0000-0000-0000000000a3', 'OWN-CAP', 'Own Cap', 1, 500, 500);
select public.start_own_delivery('f1f1f1f1-0000-0000-0000-0000000000a3', 'Mahmoud');

select is(
  public.lookup_return_by_order_number('OWN-NOTPACKED') ->> 'state',
  'needs_failure_record',
  'A parcel our driver brings back is found by its order number'
);

select lives_ok(
  $$ select public.record_delivery_failure(
       'f1f1f1f1-0000-0000-0000-0000000000a3', 'refused_after_inspection', null) $$,
  'And its failure can be recorded without any tracking code'
);

select is(
  public.lookup_return_by_order_number('OWN-NOTPACKED') ->> 'state',
  'ready_to_receive',
  'Then it is ready to check in like any other return'
);

-- --- A "no SKU" issue closes for its own product only ----------------------

select public.open_sync_issue(
  'missing_in_crm', null, null, null, null,
  jsonb_build_object('reason', 'variants_without_sku', 'shopify_product_id', 99887766, 'count', 2),
  'webhook'
);

select is(
  public.close_sku_issue(11223344),
  0,
  'Another product arriving with SKUs does not close it'
);

select is(
  public.close_sku_issue(99887766),
  1,
  'Its own product arriving with SKUs does'
);

select * from finish();
rollback;
