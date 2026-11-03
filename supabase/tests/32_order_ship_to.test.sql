-- ---------------------------------------------------------------------------
-- An order ships to its own name and number.
--
-- What matters: a Shopify order shows who Shopify says it goes to, even when
-- its number finds someone else's customer record (#1532); Shopify changing
-- the address reaches the order, Shopify re-sending the old one does not undo
-- a correction typed here; a sale typed by hand keeps the name typed; a number
-- used under another name says so; and a refusal is shown with what came
-- after it, across a second number when the whole name is the same (#1442's
-- customer refused it, then took and paid for W2610-00049).
-- ---------------------------------------------------------------------------

begin;
select plan(38);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('c5c5c5c5-0000-0000-0000-000000000001', 'Ship-to Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('c5c5c5c5-0000-0000-0000-000000000002', 'Ship-to Test Jacket');

insert into public.variants (id, product_id, sku, size, price_egp, shopify_variant_id)
values ('c5c5c5c5-0000-0000-0000-00000000000a', 'c5c5c5c5-0000-0000-0000-000000000002', 'SHIP-L', 'L', 1500.00, 99001);

select public.record_stock_movements(
  'c5c5c5c5-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"c5c5c5c5-0000-0000-0000-00000000000a","quantity_delta":50}]'::jsonb
);

insert into public.customers (id, shopify_customer_id, full_name, phone, address_line1, address_line2, city, governorate)
values
  ('c5c5c5c5-0000-0000-0000-0000000000c1', 7001, 'Mohmed Fathy', '01599977701',
   'Nasr City, 10th district', 'Next to the pharmacy', 'Nasr City', 'Cairo'),
  ('c5c5c5c5-0000-0000-0000-0000000000c2', null, 'Mohmed Fathy', '01599977702', null, null, null, null),
  ('c5c5c5c5-0000-0000-0000-0000000000c4', 7003, 'Sherif Nabil', '01599977703', null, null, 'Sadat City', 'Giza');

create temporary table t (k text primary key, v uuid) on commit drop;

-- A website order from Shopify customer p_customer, shipping to p_ship.
create or replace function pg_temp.web_order(p_id bigint, p_updated_at text, p_customer jsonb, p_ship jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'name', '#' || p_id::text, 'updated_at', p_updated_at,
    'currency', 'EGP', 'financial_status', 'pending', 'total_discounts', '0.00',
    'payment_gateway_names', jsonb_build_array('Cash on Delivery (COD)'),
    'total_shipping_price_set', jsonb_build_object('shop_money', jsonb_build_object('amount', '80.00')),
    'shipping_lines', jsonb_build_array(jsonb_build_object('title', 'Delivery', 'price', '80.00')),
    'customer', p_customer, 'shipping_address', p_ship,
    'line_items', jsonb_build_array(jsonb_build_object(
      'id', 1, 'variant_id', 99001, 'sku', 'SHIP-L', 'title', 'Ship-to Test Jacket',
      'quantity', 1, 'current_quantity', 1, 'price', '1500.00', 'total_discount', '0.00')));
$$;

-- A sale typed by hand for p_customer, left where p_status says, sent with
-- Accurate under p_tracking when one is given.
create or replace function pg_temp.sale(p_key text, p_customer uuid, p_status text,
                                        p_tracking text default null, p_ship_name text default null)
returns uuid language plpgsql as $$
declare v_order public.orders;
begin
  v_order := public.create_store_sale(
    p_location_id => 'c5c5c5c5-0000-0000-0000-000000000001',
    p_payment_method => 'cod',
    p_items => '[{"variant_id":"c5c5c5c5-0000-0000-0000-00000000000a","quantity":1}]'::jsonb,
    p_idempotency_key => p_key, p_customer_id => p_customer,
    p_channel => 'online', p_shipping_egp => 80, p_ship_name => p_ship_name);
  update public.orders set fulfillment_status = p_status::public.fulfillment_status where id = v_order.id;
  if p_tracking is not null then
    insert into public.shipments (order_id, courier, tracking_number, direction, status, cod_amount_egp, handed_over_at)
    values (v_order.id, 'accurate', p_tracking, 'outbound', 'in_transit', 1580, now() - interval '2 days');
  end if;
  return v_order.id;
end;
$$;

-- Refused at the door for p_reason, and checked back in whole.
create or replace function pg_temp.refuse(p_tracking text, p_reason text default 'refused_after_inspection')
returns void language plpgsql as $$
declare v_return public.returns;
begin
  v_return := public.record_delivery_failure_by_tracking(p_tracking, p_reason::public.return_reason);
  perform public.receive_return(v_return.id, (
    select jsonb_agg(jsonb_build_object('return_line_id', rl.id, 'quantity_resellable', rl.quantity_expected))
      from public.return_lines rl where rl.return_id = v_return.id));
end;
$$;

create or replace function pg_temp.signals(p_key text) returns jsonb language sql as $$
  select public.order_customer_signals((select v from t where k = p_key));
$$;

-- --- Names -------------------------------------------------------------------

select ok(public.names_match('Mohmed Fathy', 'محمد فتحي'),
  'Mohmed Fathy in Latin letters and محمد فتحي are one name');
select ok(not public.names_match('Mohmed Fathy', 'Omar Adel El Sayed'),
  'Mohmed Fathy and Omar Adel El Sayed are two');
select ok(public.names_match('حسام احمد', 'حسام احمد عماره محمد عماره'),
  'A name written with fewer of the father''s names is the same name');
select ok(public.names_match('Laila Ibrahim', 'ليلى إبراهيم'),
  'Laila Ibrahim and ليلى إبراهيم are one name');
select ok(not public.names_match('Ahmed Mohamed', 'Mohamed Ahmed'),
  'Order counts: Ahmed Mohamed and Mohamed Ahmed are a son and a father');
select is(public.name_key('Ahmed'), null, 'One word is not a whole name, so it ties no orders together');

-- --- #1532: a Shopify order on someone else's number ------------------------

select public.ingest_shopify_order(
  pg_temp.web_order(9532, '2026-11-02T02:48:00+02:00',
    jsonb_build_object('id', 7002, 'first_name', 'Omar', 'last_name', 'Adel El Sayed',
                       'email', 'omar@example.com'),
    jsonb_build_object('first_name', 'Omar', 'last_name', 'Adel El Sayed', 'phone', '+20 159 997 7701',
                       'address1', 'First Settlement', 'address2', '7', 'city', 'New Cairo', 'province', 'Cairo')),
  'c5c5c5c5-0000-0000-0000-000000000001');
insert into t values ('ahmed', (select id from public.orders where shopify_order_id = 9532));

select is((select customer_id from public.orders where id = (select v from t where k = 'ahmed')),
  'c5c5c5c5-0000-0000-0000-0000000000c1'::uuid,
  'The number still finds the customer record it belongs to');
select is(
  (select row(ship_name, ship_phone, ship_city)::text from public.orders where id = (select v from t where k = 'ahmed')),
  row('Omar Adel El Sayed', '01599977701', 'New Cairo')::text,
  'The order ships to who Shopify says, with the number in one shape');
select is(
  (select row(customer_name, customer_phone)::text from public.v_order_list where id = (select v from t where k = 'ahmed')),
  row('Omar Adel El Sayed', '01599977701')::text,
  'The orders list shows the order''s own name, not the customer record''s');
select ok(
  (select customer_address like 'First Settlement%' from public.v_order_list where id = (select v from t where k = 'ahmed')),
  'and the order''s own address');
select is(
  (select row(full_name, email::text)::text from public.customers where id = 'c5c5c5c5-0000-0000-0000-0000000000c1'),
  row('Mohmed Fathy', null)::text,
  'The customer record keeps its name, and another Shopify customer''s email is not written into it');

-- --- Shopify changes the address; a correction here stays -------------------

select public.ingest_shopify_order(
  pg_temp.web_order(9487, '2026-10-27T15:33:00+02:00',
    jsonb_build_object('id', 7003, 'first_name', 'Sherif', 'last_name', 'Nabil'),
    jsonb_build_object('first_name', 'Sherif', 'last_name', 'Nabil', 'phone', '01599977703',
                       'city', 'Sadat City', 'province', 'Giza')),
  'c5c5c5c5-0000-0000-0000-000000000001');
select public.sync_shopify_order_lines(pg_temp.web_order(9487, '2026-10-27T16:00:00+02:00',
  jsonb_build_object('id', 7003, 'first_name', 'Sherif', 'last_name', 'Nabil'),
  jsonb_build_object('first_name', 'Sherif', 'last_name', 'Nabil', 'phone', '01599977704',
                     'city', 'Sadat City', 'province', 'Alexandria')));
select is((select ship_phone from public.orders where shopify_order_id = 9487),
  '01599977704', 'A new number in Shopify reaches the order (#1487)');
select is((select governorate from public.v_report_orders where order_number = '#9487'),
  'Alexandria', 'An area in the reports is where the parcel went, not the customer record''s');

select public.update_order_ship_to((select v from t where k = 'ahmed'),
  'Omar El Sayed', '+20 159 997 7701', 'First Settlement, building 25 B', '7', 'New Cairo', 'Cairo');
select is(
  (select row(ship_name, ship_phone, ship_address_line1)::text from public.orders where id = (select v from t where k = 'ahmed')),
  row('Omar El Sayed', '01599977701', 'First Settlement, building 25 B')::text,
  'Correcting the order changes the order');
select is(
  (select details -> 'to' ->> 'name' from public.order_events
    where order_id = (select v from t where k = 'ahmed') and event_type = 'ship_to_edited'),
  'Omar El Sayed', 'and the change is in its history');
select is((select full_name from public.customers where id = 'c5c5c5c5-0000-0000-0000-0000000000c1'),
  'Mohmed Fathy', 'and leaves the customer record, and every other order of theirs, alone');

-- The same ship-to again, on a later version (a tag, a payment).
select public.sync_shopify_order_lines(pg_temp.web_order(9532, '2026-11-02T04:00:00+02:00',
  jsonb_build_object('id', 7002, 'first_name', 'Omar', 'last_name', 'Adel El Sayed'),
  jsonb_build_object('first_name', 'Omar', 'last_name', 'Adel El Sayed', 'phone', '01599977701',
                     'address1', 'First Settlement', 'address2', '7', 'city', 'New Cairo', 'province', 'Cairo')));
select is((select ship_name from public.orders where id = (select v from t where k = 'ahmed')),
  'Omar El Sayed', 'Shopify sending its old ship-to again does not undo the correction');

select public.sync_shopify_order_lines(pg_temp.web_order(9532, '2026-11-02T05:00:00+02:00',
  jsonb_build_object('id', 7002, 'first_name', 'Omar', 'last_name', 'Adel El Sayed'),
  jsonb_build_object('first_name', 'Omar', 'last_name', 'Adel El Sayed', 'phone', '01599977701',
                     'address1', 'Fifth Settlement', 'city', 'New Cairo', 'province', 'Cairo')));
select is(
  (select row(ship_name, ship_address_line1, ship_address_line2)::text from public.orders where id = (select v from t where k = 'ahmed')),
  row('Omar Adel El Sayed', 'Fifth Settlement', null)::text,
  'A new address in Shopify does, whole');

-- --- A sale typed by hand ---------------------------------------------------

insert into t values ('typed', pg_temp.sale('ship-typed-01', 'c5c5c5c5-0000-0000-0000-0000000000c1',
                                            'awaiting_confirmation', null, 'Tarek Fathy'));
select is(
  (select row(ship_name, ship_phone, ship_city)::text from public.orders where id = (select v from t where k = 'typed')),
  row('Tarek Fathy', '01599977701', 'Nasr City')::text,
  'A name typed with a known number stays on the order; the rest comes from the record');

insert into t values ('plain', pg_temp.sale('ship-plain-01', 'c5c5c5c5-0000-0000-0000-0000000000c1', 'awaiting_confirmation'));
select is(
  (select row(ship_name, ship_address_line2)::text from public.orders where id = (select v from t where k = 'plain')),
  row('Mohmed Fathy', 'Next to the pharmacy')::text,
  'Nothing typed: the order ships to the customer record');

-- --- Mohmed Fathy: refused, then took and paid on a second number ---------

insert into t values ('refused', pg_temp.sale('ship-ref-01', 'c5c5c5c5-0000-0000-0000-0000000000c1', 'in_transit', 'SHIP-REF-1'));
select pg_temp.refuse('SHIP-REF-1');
update public.orders set created_at = now() - interval '12 days' where id = (select v from t where k = 'refused');

insert into t values ('took', pg_temp.sale('ship-took-01', 'c5c5c5c5-0000-0000-0000-0000000000c2', 'delivered'));
update public.orders set created_at = now() - interval '8 days', payment_status = 'paid'
 where id = (select v from t where k = 'took');

insert into t values ('next', pg_temp.sale('ship-next-01', 'c5c5c5c5-0000-0000-0000-0000000000c1', 'awaiting_pickup'));

select is((pg_temp.signals('next') ->> 'refused')::int, 1, 'His next order knows of the refusal');
select is((pg_temp.signals('next') ->> 'received')::int, 1, 'and of the order he took on his other number');
select is((pg_temp.signals('next') ->> 'received_since_refusal')::int, 1, 'which came after it: the refusal was made good');
select is(
  (select row(h ->> 'via', h ->> 'phone')::text
     from jsonb_array_elements(pg_temp.signals('next') -> 'history') h where h ->> 'outcome' = 'received'),
  row('name', '01599977702')::text,
  'It says that order was tied by name, and to which number');
select is(
  (select customer_signals from public.v_packing_queue where order_id = (select v from t where k = 'next')),
  pg_temp.signals('next'), 'The packing queue carries the same');

select is(
  (select array_agg(n ->> 'name' order by n ->> 'name' collate "C")
     from jsonb_array_elements(pg_temp.signals('next') -> 'other_names') n),
  array['Omar Adel El Sayed', 'Tarek Fathy'],
  'His number has gone under two other names');
select is(
  (select n -> 'orders' from jsonb_array_elements(pg_temp.signals('next') -> 'other_names') n
    where n ->> 'name' = 'Omar Adel El Sayed'),
  '["#9532"]'::jsonb, 'each with the orders it was on');
select ok(
  (select bool_or(n ->> 'name' = 'Mohmed Fathy') from jsonb_array_elements(pg_temp.signals('ahmed') -> 'other_names') n),
  'Omar''s order says the number is also Mohmed Fathy''s');

-- A refusal the courier caused is not the customer's.
insert into t values ('timeout', pg_temp.sale('ship-tmo-01', 'c5c5c5c5-0000-0000-0000-0000000000c1', 'in_transit', 'SHIP-TMO-1'));
select pg_temp.refuse('SHIP-TMO-1', 'delivery_timeout');
select is((pg_temp.signals('next') ->> 'refused')::int, 1, 'The courier running out of time is not a refusal');

-- A refusal with nothing after it stays one.
insert into public.customers (id, full_name, phone)
values ('c5c5c5c5-0000-0000-0000-0000000000c3', 'Karim Fawzy', '01599977705');
insert into t values ('k_ref', pg_temp.sale('ship-kref-01', 'c5c5c5c5-0000-0000-0000-0000000000c3', 'in_transit', 'SHIP-KREF-1'));
select pg_temp.refuse('SHIP-KREF-1');
insert into t values ('k_next', pg_temp.sale('ship-knext-01', 'c5c5c5c5-0000-0000-0000-0000000000c3', 'awaiting_pickup'));
select is(
  (select row(s ->> 'refused', s ->> 'received_since_refusal')::text from (select pg_temp.signals('k_next') s) x),
  row('1', '0')::text, 'A refusal with nothing taken after it is still a refusal');
select is(pg_temp.signals('k_next') -> 'other_names', '[]'::jsonb, 'A number with one name says nothing about it');

-- A common name on many numbers ties nobody together.
insert into public.customers (id, full_name, phone)
values
  ('c5c5c5c5-0000-0000-0000-0000000000d1', 'Mohamed Ahmed', '01599977711'),
  ('c5c5c5c5-0000-0000-0000-0000000000d2', 'Mohamed Ahmed', '01599977712'),
  ('c5c5c5c5-0000-0000-0000-0000000000d3', 'Mohamed Ahmed', '01599977713');
insert into t values ('m_ref', pg_temp.sale('ship-mref-01', 'c5c5c5c5-0000-0000-0000-0000000000d1', 'in_transit', 'SHIP-MREF-1'));
select pg_temp.refuse('SHIP-MREF-1');
insert into t values ('m2', pg_temp.sale('ship-m2-01', 'c5c5c5c5-0000-0000-0000-0000000000d2', 'delivered'));
insert into t values ('m_next', pg_temp.sale('ship-mnext-01', 'c5c5c5c5-0000-0000-0000-0000000000d3', 'awaiting_pickup'));
select is((pg_temp.signals('m_next') ->> 'refused')::int, 0,
  'Mohamed Ahmed on three numbers is three people: one''s refusal is not the others''');

-- --- The reports read the same ------------------------------------------------

select is(
  (select row(refusals, received_since_refusal)::text from public.v_customer_reliability
    where customer_id = 'c5c5c5c5-0000-0000-0000-0000000000c1'),
  row(1, 1)::text,
  'The customers report counts the refusal - not the courier''s - and what was taken after it on the other number');
select is(
  (select refusals::int from public.v_customer_reliability where customer_id = 'c5c5c5c5-0000-0000-0000-0000000000c2'),
  0, 'and does not list the other number as a second refuser');

-- #1497: refused at the door, but kept one of the two.
insert into public.customers (id, full_name, phone)
values ('c5c5c5c5-0000-0000-0000-0000000000c6', 'Salma Adel', '01599977706');
do $$
declare v_order public.orders; v_return public.returns;
begin
  v_order := public.create_store_sale(
    p_location_id => 'c5c5c5c5-0000-0000-0000-000000000001', p_payment_method => 'cod',
    p_items => '[{"variant_id":"c5c5c5c5-0000-0000-0000-00000000000a","quantity":2}]'::jsonb,
    p_idempotency_key => 'ship-kept-01', p_customer_id => 'c5c5c5c5-0000-0000-0000-0000000000c6',
    p_channel => 'online', p_shipping_egp => 80);
  update public.orders set fulfillment_status = 'in_transit' where id = v_order.id;
  insert into public.shipments (order_id, courier, tracking_number, direction, status, cod_amount_egp, handed_over_at)
  values (v_order.id, 'accurate', 'SHIP-KEPT-1', 'outbound', 'in_transit', 3080, now() - interval '2 days');
  v_return := public.record_delivery_failure_by_tracking('SHIP-KEPT-1', 'wrong_size');
  perform public.receive_return(v_return.id, (
    select jsonb_agg(jsonb_build_object('return_line_id', rl.id, 'quantity_resellable', 1, 'quantity_kept', 1))
      from public.return_lines rl where rl.return_id = v_return.id));
  insert into t values ('kept', v_order.id);
end $$;

select is((select outcome from public.v_report_orders where order_id = (select v from t where k = 'kept')),
  'delivered', 'A refusal that kept something is a delivery in the reports (#1497)');
select is(
  (select refusals::int from public.v_customer_reliability where customer_id = 'c5c5c5c5-0000-0000-0000-0000000000c6'),
  0, 'and its customer is not listed as refusing');

-- --- A replacement ----------------------------------------------------------
-- Last, because it puts Ahmed's ship-to on one more order.

update public.orders set exchange_for_order_id = (select v from t where k = 'ahmed')
 where id = (select v from t where k = 'plain');
select is((select ship_address_line1 from public.orders where id = (select v from t where k = 'plain')),
  'Fifth Settlement', 'A replacement ships where the order it replaces went');

-- --- Who may correct it -------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5c5c5c5-0000-0000-0000-00000000dead"}';
select throws_ok(
  $$ select public.update_order_ship_to('c5c5c5c5-0000-0000-0000-0000000000ff', 'X', null, null, null, null, null) $$,
  '42501', null, 'Someone without orders.edit cannot change where an order ships');
reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
