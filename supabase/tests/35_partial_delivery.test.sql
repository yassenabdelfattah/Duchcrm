-- ---------------------------------------------------------------------------
-- Delivered in part: the customer kept some of the parcel and the courier is
-- bringing the rest back.
--
-- What matters: the order is delivered of what was kept; a refusal is opened
-- for the rest, coming back, with every piece's count; the refused pieces come
-- off what is owed and what the statement should say at once, while stock
-- comes back only at check-in, which starts from these counts; a prepaid
-- customer is owed the refused pieces back; our driver's cash comes in with
-- it; it is refused where it does not fit; and pressed by mistake it can be
-- taken back while the pieces are still on the way.
-- ---------------------------------------------------------------------------

begin;
select plan(38);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('c5c5c5c5-0000-0000-0000-00000000000c', 'pd-packing@test.local', 'authenticated', 'authenticated'),
  ('c5c5c5c5-0000-0000-0000-00000000000d', 'pd-sales@test.local', 'authenticated', 'authenticated');
update public.staff set role = 'packing', is_active = true where id = 'c5c5c5c5-0000-0000-0000-00000000000c';
update public.staff set role = 'sales', is_active = true where id = 'c5c5c5c5-0000-0000-0000-00000000000d';

insert into public.roles (id, name_ar, permissions)
values ('c5c5c5c5-0000-0000-0000-0000000000e1', 'عرض فقط للتسليم الجزئي', array['orders.read']);
insert into auth.users (id, email, aud, role) values
  ('c5c5c5c5-0000-0000-0000-00000000000e', 'pd-viewer@test.local', 'authenticated', 'authenticated');
update public.staff set role_id = 'c5c5c5c5-0000-0000-0000-0000000000e1', is_active = true
 where id = 'c5c5c5c5-0000-0000-0000-00000000000e';

insert into public.locations (id, name, type, is_default, is_active)
values ('c5c5c5c5-0000-0000-0000-000000000001', 'Partial Delivery Shop', 'store', false, true);

insert into public.products (id, title)
values ('c5c5c5c5-0000-0000-0000-000000000002', 'Partial Delivery Hoodie');

insert into public.variants (id, product_id, sku, size, price_egp)
values
  ('c5c5c5c5-0000-0000-0000-00000000000a', 'c5c5c5c5-0000-0000-0000-000000000002', 'PD-A', 'M', 500.00),
  ('c5c5c5c5-0000-0000-0000-00000000000b', 'c5c5c5c5-0000-0000-0000-000000000002', 'PD-B', 'L', 300.00);

select public.record_stock_movements(
  'c5c5c5c5-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"c5c5c5c5-0000-0000-0000-00000000000a","quantity_delta":20},
    {"variant_id":"c5c5c5c5-0000-0000-0000-00000000000b","quantity_delta":20}]'::jsonb
);

create or replace function pg_temp.stock(p_sku text) returns integer language sql as $$
  select sl.quantity from public.stock_levels sl join public.variants v on v.id = sl.variant_id
   where v.sku = p_sku and sl.location_id = 'c5c5c5c5-0000-0000-0000-000000000001';
$$;

-- One A and two B, 100 off (1,000 for 1,100 of goods), shipping 70, out with
-- p_courier and left where p_status says; cash on delivery unless paid online.
create or replace function pg_temp.sent_order(p_key text, p_status text, p_courier text default 'accurate',
                                              p_method text default 'cod')
returns uuid language plpgsql as $$
declare v_order public.orders;
begin
  v_order := public.create_store_sale(
    p_location_id => 'c5c5c5c5-0000-0000-0000-000000000001',
    p_payment_method => p_method::public.payment_method,
    p_items => '[{"variant_id":"c5c5c5c5-0000-0000-0000-00000000000a","quantity":1},
                 {"variant_id":"c5c5c5c5-0000-0000-0000-00000000000b","quantity":2}]'::jsonb,
    p_idempotency_key => 'partial-delivery-' || p_key, p_discount_egp => 100,
    p_channel => 'dm', p_shipping_egp => 70);
  update public.orders
     set fulfillment_status = p_status::public.fulfillment_status,
         payment_status = case when p_method = 'card' then 'paid'::public.payment_status else 'pending' end
   where id = v_order.id;
  insert into public.shipments (order_id, courier, driver_name, tracking_number, direction, status, cod_amount_egp, handed_over_at)
  values (v_order.id, p_courier, case when p_courier = 'own' then 'Mahmoud' end,
          case when p_courier <> 'own' then 'PD-' || p_key end, 'outbound', p_status::public.shipment_status,
          case when p_method = 'cod' then 1070 else 0 end, now() - interval '2 days');
  return v_order.id;
end;
$$;

-- What the customer took: p_a of the A, p_b of the two B.
create or replace function pg_temp.took(p_order uuid, p_a integer, p_b integer) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('order_line_item_id', (select id from public.order_line_items where order_id = p_order and sku = 'PD-A'),
                       'quantity_kept', p_a),
    jsonb_build_object('order_line_item_id', (select id from public.order_line_items where order_id = p_order and sku = 'PD-B'),
                       'quantity_kept', p_b));
$$;

create temporary table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated;

insert into t values
  ('door',     pg_temp.sent_order('pd-door',     'in_transit')),
  ('prepaid',  pg_temp.sent_order('pd-prepaid',  'in_transit', 'accurate', 'card')),
  ('own',      pg_temp.sent_order('pd-own',      'out_for_delivery', 'own')),
  ('marked',   pg_temp.sent_order('pd-marked',   'in_transit')),
  ('mistake',  pg_temp.sent_order('pd-mistake',  'in_transit')),
  ('refused',  pg_temp.sent_order('pd-refused',  'in_transit')),
  ('pickup',   pg_temp.sent_order('pd-pickup',   'awaiting_pickup'));

-- The stock after the sales, for what the check-in puts back.
create temporary table s (k text primary key, n integer) on commit drop;
grant all on s to authenticated;
insert into s values ('a', pg_temp.stock('PD-A')), ('b', pg_temp.stock('PD-B'));

-- --- Who may ------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5c5c5c5-0000-0000-0000-00000000000e"}';

select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'door'), pg_temp.took((select v from t where k = 'door'), 0, 2)) $$,
  '42501', null, 'Someone who can only look at orders cannot record a delivery');

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"c5c5c5c5-0000-0000-0000-00000000000c"}';

-- --- With the courier: kept both B, the A is coming back ----------------------

select lives_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'door'),
                                           pg_temp.took((select v from t where k = 'door'), 0, 2),
                                           'wrong_size', 'The M was too small') $$,
  'Packing, who marks courier parcels delivered, records what the customer took');

select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'own'), pg_temp.took((select v from t where k = 'own'), 1, 1)) $$,
  '42501', 'Not allowed to record cash received',
  'but not our driver''s: that brings the cash in, which packing does not record');

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select row(o.fulfillment_status, o.payment_status, s.status)::text
     from public.orders o join public.shipments s on s.order_id = o.id
    where o.id = (select v from t where k = 'door')),
  row('delivered', 'pending', 'delivered')::text,
  'The order and its parcel are delivered; the cash is still the courier''s');

select is(
  (select row(r.type, r.reason, r.status, r.note, r.value_egp, r.refund_egp)::text
     from public.returns r where r.order_id = (select v from t where k = 'door')),
  row('failed_delivery', 'wrong_size', 'expected', 'The M was too small', 454.55, 0.00)::text,
  'A refusal at the door is opened, coming back, at what the A sold for after the discount, owed nobody');

select is(
  (select string_agg(rl.sku || ':' || rl.quantity_kept || '/' || rl.quantity_expected, ' ' order by rl.sku)
     from public.return_lines rl join public.returns r on r.id = rl.return_id
    where r.order_id = (select v from t where k = 'door')),
  'PD-A:0/1 PD-B:2/0',
  'Every piece is on it: the B kept, the A coming back');

select is(
  (select row(returned_off_egp, return_refund_owed_egp)::text from public.v_order_list where id = (select v from t where k = 'door')),
  row(454.55, 0.00)::text,
  'The A comes off the bill at once');

select is(
  (select public.settlement_goods(s.id) from public.shipments s where s.order_id = (select v from t where k = 'door')),
  545.45, 'and off what the courier''s statement should say the goods came to');

select is(
  (select string_agg((i ->> 'sku') || ':' || (i ->> 'coming_back') || '/' || (i ->> 'returned'), ' ' order by i ->> 'sku')
     from public.v_order_list o, jsonb_array_elements(o.items) i where o.id = (select v from t where k = 'door')),
  'PD-A:1/0 PD-B:0/0',
  'The order''s lines say the A is on its way back');

select is(
  (select row(units_expected, items)::text from public.v_returns_inbound where order_id = (select v from t where k = 'door')),
  row(1, 'PD-A x1')::text,
  'Returns lists it coming back: the A alone');

select is(
  (select row(pg_temp.stock('PD-A'), pg_temp.stock('PD-B'))::text),
  (select row((select n from s where k = 'a'), (select n from s where k = 'b'))::text),
  'No stock moves until the A is on the table');

select is(
  (select row(e.details ->> 'kept', e.details ->> 'back', e.note, e.staff_id)::text
     from public.order_events e where e.order_id = (select v from t where k = 'door') and e.event_type = 'partial_delivery'),
  row('2', '1', 'The M was too small', 'c5c5c5c5-0000-0000-0000-00000000000c')::text,
  'The history says what was taken and what is coming back, and who said so');

select is(public.order_outcome((select v from t where k = 'door')), 'received',
  'The customer took the parcel: it is no refusal against them');

select is(
  (select string_agg(sku || ':' || quantity, ' ' order by sku) from public.v_report_returns where order_id = (select v from t where k = 'door')),
  'PD-A:1', 'The reports take off the A alone');

-- On a statement as delivered, the products leave the A out already.
insert into public.courier_settlements (id, reference)
values ('c5c5c5c5-0000-0000-0000-0000000000f1', 'PD-STATEMENT');
insert into public.settlement_lines (settlement_id, order_id, tracking_number, outcome, collected_egp, fee_egp, customer_shipping_egp)
values ('c5c5c5c5-0000-0000-0000-0000000000f1', (select v from t where k = 'door'), 'PD-pd-door', 'delivered', 615.45, 70, 70);

select is(
  (select string_agg(title || ' x' || quantity || ' = ' || total_egp, ', ') from public.v_settlement_products
    where settlement_id = 'c5c5c5c5-0000-0000-0000-0000000000f1'),
  'Partial Delivery Hoodie x2 = 600.00',
  'The statement''s products are the two B the customer paid for');
select is(
  (select collection_difference_egp from public.v_settlement_breakdown where settlement_id = 'c5c5c5c5-0000-0000-0000-0000000000f1'),
  0.00, 'and what the courier collected for them meets what the CRM expected');

-- --- The A arrives ---------------------------------------------------------------

select is(
  (public.lookup_return_by_tracking('PD-pd-door')) ->> 'state', 'ready_to_receive',
  'Scanned on Returns, it is ready to check in');

select public.receive_return(
  (select id from public.returns where order_id = (select v from t where k = 'door')),
  (select jsonb_agg(jsonb_build_object(
            'return_line_id', rl.id,
            'quantity_resellable', rl.quantity_expected,
            'quantity_damaged', 0,
            'quantity_kept', rl.quantity_kept))
     from public.return_lines rl join public.returns r on r.id = rl.return_id
    where r.order_id = (select v from t where k = 'door')));

select is(
  (select row(r.status, r.value_egp, o.fulfillment_status)::text
     from public.returns r join public.orders o on o.id = r.order_id where r.order_id = (select v from t where k = 'door')),
  row('received', 454.55, 'delivered')::text,
  'Checked in as counted: received, the same value, the order still delivered');
select is(pg_temp.stock('PD-A'), (select n from s where k = 'a') + 1, 'and the A is back on the shelf');
select is(
  (select returned_off_egp from public.v_order_list where id = (select v from t where k = 'door')),
  454.55, 'Nothing comes off twice');

-- --- Paid online before it left ------------------------------------------------------

select public.record_partial_delivery((select v from t where k = 'prepaid'), pg_temp.took((select v from t where k = 'prepaid'), 1, 1));

select is(
  (select row(r.value_egp, r.refund_egp)::text from public.returns r where r.order_id = (select v from t where k = 'prepaid')),
  row(272.73, 272.73)::text,
  'Paid online: the refused B is owed back to the customer');
select is(
  (select row(returned_off_egp, return_refund_owed_egp)::text from public.v_order_list where id = (select v from t where k = 'prepaid')),
  row(0.00, 272.73)::text,
  'shown as owed back, not off a bill already paid');

-- --- Our driver ---------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5c5c5c5-0000-0000-0000-00000000000d"}';

select lives_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'own'), pg_temp.took((select v from t where k = 'own'), 1, 1)) $$,
  'Sales, who record our driver''s cash, record what the customer took from him');

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select row(o.fulfillment_status, o.payment_status, l.returned_off_egp)::text
     from public.orders o join public.v_order_list l on l.id = o.id where o.id = (select v from t where k = 'own')),
  row('delivered', 'paid', 272.73)::text,
  'Delivered, and the cash he brought in for what was kept is paid');
select is(
  (select total_egp + shipping_egp - returned_off_egp from public.v_order_list where id = (select v from t where k = 'own')),
  797.27, 'The cash is the A, one B and the shipping');

-- --- Already marked delivered ---------------------------------------------------------

select public.mark_courier_delivered((select v from t where k = 'marked'));
select lives_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'marked'), pg_temp.took((select v from t where k = 'marked'), 1, 0)) $$,
  'Marked delivered in a batch, and then the courier says the customer kept only part: recorded');
select is(
  (select row(o.fulfillment_status, l.returned_off_egp)::text
     from public.orders o join public.v_order_list l on l.id = o.id where o.id = (select v from t where k = 'marked')),
  row('delivered', 545.45)::text,
  'It stays delivered, the two B off the bill');

-- --- Where it does not fit ----------------------------------------------------------

select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'refused'), pg_temp.took((select v from t where k = 'refused'), 1, 2)) $$,
  '23514', 'Nothing on order ' || (select order_number from public.orders where id = (select v from t where k = 'refused'))
           || ' is coming back: the customer took it all',
  'Everything taken is a delivery, not a part of one');
select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'refused'), pg_temp.took((select v from t where k = 'refused'), 0, 0)) $$,
  '23514', 'The customer took nothing of order ' || (select order_number from public.orders where id = (select v from t where k = 'refused'))
           || ': record it refused on Returns',
  'Nothing taken is a refusal, recorded on Returns');
select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'refused'), pg_temp.took((select v from t where k = 'refused'), 0, 3)) $$,
  '23514', 'Only 2 of PD-B went out',
  'More taken than went out is refused');
select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'pickup'), pg_temp.took((select v from t where k = 'pickup'), 1, 0)) $$,
  '23514', 'Order ' || (select order_number from public.orders where id = (select v from t where k = 'pickup'))
           || ' is not with the courier or the customer',
  'Still waiting for the courier to collect it: nothing to deliver');
select throws_ok(
  $$ select public.record_partial_delivery((select v from t where k = 'door'), pg_temp.took((select v from t where k = 'door'), 1, 1)) $$,
  '23514', 'Order ' || (select order_number from public.orders where id = (select v from t where k = 'door'))
           || ' already has a return: say what the customer kept when it is checked in',
  'Something already back on it: what was kept is said at its check-in');

select public.record_delivery_failure((select v from t where k = 'refused'), 'refused_after_inspection');
select is(
  (select returned_off_egp from public.v_order_list where id = (select v from t where k = 'refused')),
  0::numeric, 'A whole refusal still with the courier takes nothing off before it is back');

-- --- Pressed by mistake ------------------------------------------------------------

select public.record_partial_delivery((select v from t where k = 'mistake'), pg_temp.took((select v from t where k = 'mistake'), 1, 1));
select lives_ok(
  $$ select public.undo_delivered((select v from t where k = 'mistake'), 'Wrong order') $$,
  'A partial delivery pressed by mistake is taken back while its piece is on the way');
select is(
  (select row(o.fulfillment_status, (select count(*) from public.returns r where r.order_id = o.id), l.returned_off_egp)::text
     from public.orders o join public.v_order_list l on l.id = o.id where o.id = (select v from t where k = 'mistake')),
  row('in_transit', 0, 0)::text,
  'It is back with the courier, the refusal gone with it and nothing off the bill');
select is(
  (select e.details -> 'partial_cleared' from public.order_events e
    where e.order_id = (select v from t where k = 'mistake') and e.event_type = 'delivery_undone'),
  '[{"sku": "PD-A", "back": 0, "kept": 1}, {"sku": "PD-B", "back": 1, "kept": 1}]'::jsonb,
  'The history keeps what it had said');

select throws_ok(
  $$ select public.undo_delivered((select v from t where k = 'door')) $$,
  '23514', 'Order ' || (select order_number from public.orders where id = (select v from t where k = 'door'))
           || ' has pieces back from the customer',
  'Once the piece is checked in, the return is the record and it is not taken back');
select throws_ok(
  $$ select public.undo_delivered((select v from t where k = 'own')) $$,
  '23514', 'Order ' || (select order_number from public.orders where id = (select v from t where k = 'own'))
           || ' was paid on delivery: reopen its payment first',
  'Our driver''s, paid with it: the payment is reopened first, as for any delivery');

select * from finish();
rollback;
