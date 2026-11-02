-- ---------------------------------------------------------------------------
-- One piece of an order comes back while the customer keeps the rest.
--
-- What matters: nothing the customer kept is counted missing; the order stays
-- delivered until every piece is back; a refusal at the door comes off what
-- the courier should collect; a paid customer is owed back what they returned,
-- after the order's discount; a customer on a tab simply owes less; and the
-- reports take off only what came back.
-- ---------------------------------------------------------------------------

begin;
select plan(39);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('b1b1b1b1-0000-0000-0000-000000000001', 'Partial Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('b1b1b1b1-0000-0000-0000-000000000002', 'Partial Test Hoodie');

insert into public.variants (id, product_id, sku, size, price_egp)
values
  ('b1b1b1b1-0000-0000-0000-00000000000a', 'b1b1b1b1-0000-0000-0000-000000000002', 'PART-A', 'M', 500.00),
  ('b1b1b1b1-0000-0000-0000-00000000000b', 'b1b1b1b1-0000-0000-0000-000000000002', 'PART-B', 'L', 300.00);

select public.record_stock_movements(
  'b1b1b1b1-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"b1b1b1b1-0000-0000-0000-00000000000a","quantity_delta":20},
    {"variant_id":"b1b1b1b1-0000-0000-0000-00000000000b","quantity_delta":20}]'::jsonb
);

create or replace function pg_temp.stock(p_sku text) returns integer language sql as $$
  select sl.quantity from public.stock_levels sl join public.variants v on v.id = sl.variant_id
   where v.sku = p_sku and sl.location_id = 'b1b1b1b1-0000-0000-0000-000000000001';
$$;

-- An order of one A and two B, shipping 70, sent by Accurate under p_tracking
-- (cash on delivery unless paid online) and left where p_status says.
create or replace function pg_temp.courier_order(p_key text, p_tracking text, p_status text,
                                                 p_method text default 'cod', p_discount numeric default 0)
returns uuid language plpgsql as $$
declare v_id uuid; v_order public.orders;
begin
  v_order := public.create_store_sale(
    p_location_id => 'b1b1b1b1-0000-0000-0000-000000000001',
    p_payment_method => p_method::public.payment_method,
    p_items => '[{"variant_id":"b1b1b1b1-0000-0000-0000-00000000000a","quantity":1},
                 {"variant_id":"b1b1b1b1-0000-0000-0000-00000000000b","quantity":2}]'::jsonb,
    p_idempotency_key => p_key, p_discount_egp => p_discount,
    p_channel => 'dm', p_shipping_egp => 70);
  v_id := v_order.id;
  update public.orders set fulfillment_status = p_status::public.fulfillment_status where id = v_id;
  insert into public.shipments (order_id, courier, tracking_number, direction, status, cod_amount_egp, handed_over_at)
  values (v_id, 'accurate', p_tracking, 'outbound', p_status::public.shipment_status,
          case when p_method = 'cod' then v_order.total_egp + 70 else 0 end, now() - interval '2 days');
  return v_id;
end;
$$;

create or replace function pg_temp.line_of(p_order uuid, p_sku text) returns uuid language sql as $$
  select id from public.order_line_items where order_id = p_order and sku = p_sku;
$$;

-- The return's line for a sku.
create or replace function pg_temp.rline(p_return uuid, p_sku text) returns uuid language sql as $$
  select id from public.return_lines where return_id = p_return and sku = p_sku;
$$;

create temporary table t (k text primary key, v uuid) on commit drop;

-- --- Refused in part at the door ---------------------------------------------
--
-- One A and two B, 100 off (1,000 for 1,100 of goods). The customer kept both
-- B and refused the A.

insert into t values ('door', pg_temp.courier_order('part-door-0001', 'PART-DOOR-1', 'in_transit', 'cod', 100));
insert into t values ('door_ret', (public.record_delivery_failure_by_tracking('PART-DOOR-1', 'refused_after_inspection')).id);

select public.receive_return(
  (select v from t where k = 'door_ret'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'door_ret'), 'PART-A'),
                       'quantity_resellable', 1, 'quantity_damaged', 0, 'quantity_kept', 0),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'door_ret'), 'PART-B'),
                       'quantity_resellable', 0, 'quantity_damaged', 0, 'quantity_kept', 2)));

select is(
  (select fulfillment_status::text from public.orders where id = (select v from t where k = 'door')),
  'delivered',
  'Kept in part at the door, the order is delivered - of what was kept'
);

select is(
  (select status::text from public.shipments where tracking_number = 'PART-DOOR-1'),
  'delivered',
  'And so is its parcel'
);

select is(
  (select status::text from public.returns where id = (select v from t where k = 'door_ret')),
  'received',
  'Nothing the customer kept is counted missing'
);

select is(
  (select row(quantity_expected, quantity_kept)::text from public.return_lines
    where id = pg_temp.rline((select v from t where k = 'door_ret'), 'PART-B')),
  '(0,2)',
  'The kept line expects nothing back and says it was kept'
);

select is(
  (select row(value_egp, refund_egp)::text from public.returns where id = (select v from t where k = 'door_ret')),
  '(454.55,0.00)',
  'The refused A is worth 500 less its share of the discount, and nothing was paid for it'
);

select is(pg_temp.stock('PART-A'), 20, 'The refused A is back on the shelf (20 - 1 sold + 1)');
select is(pg_temp.stock('PART-B'), 18, 'The kept Bs are not (20 - 2 sold)');

select is(
  (select returned_off_egp from public.v_order_list where id = (select v from t where k = 'door')),
  454.55::numeric,
  'The refused A comes off what the order owes'
);

select is(
  (select stage from public.v_order_list where id = (select v from t where k = 'door')),
  'delivered',
  'And it stays on the owed list, for the Bs'
);

select is(
  public.settlement_goods((select id from public.shipments where tracking_number = 'PART-DOOR-1')),
  545.45::numeric,
  'The courier should have collected for the Bs alone'
);

select is(
  (select (public.lookup_shipment_for_settlement('PART-DOOR-1') ->> 'expected_egp')::numeric),
  615.45::numeric,
  'With the shipping, as their statement should read'
);

select is(
  (select (item ->> 'returned')::int
     from public.v_order_list, jsonb_array_elements(items) item
    where id = (select v from t where k = 'door') and item ->> 'sku' = 'PART-A'),
  1,
  'The order''s A says it came back'
);

select is(
  (select coalesce(sum(quantity), 0)::int from public.v_report_returns where order_id = (select v from t where k = 'door')),
  1,
  'The reports take off the A alone'
);

select throws_ok(
  format($$ select public.update_order_details(%L, p_shipping_egp => 80) $$, (select v from t where k = 'door')),
  '23514', null,
  'Its money is closed now pieces are back'
);

-- --- All of it kept is not a return ------------------------------------------

insert into t values ('kept', pg_temp.courier_order('part-kept-0001', 'PART-KEPT-1', 'in_transit'));
insert into t values ('kept_ret', (public.record_delivery_failure_by_tracking('PART-KEPT-1', 'refused_after_inspection')).id);

select throws_ok(
  format($$ select public.receive_return(%L, %L::jsonb) $$,
    (select v from t where k = 'kept_ret'),
    jsonb_build_array(
      jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'kept_ret'), 'PART-A'), 'quantity_kept', 1),
      jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'kept_ret'), 'PART-B'), 'quantity_kept', 2))),
  '23514', null,
  'A customer who kept everything did not return anything'
);

select throws_ok(
  format($$ select public.receive_return(%L, %L::jsonb) $$,
    (select v from t where k = 'kept_ret'),
    jsonb_build_array(
      jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'kept_ret'), 'PART-B'),
                         'quantity_resellable', 2, 'quantity_kept', 1))),
  '23514', null,
  'Nor can more be counted than went out'
);

-- --- Refused whole, as before ---------------------------------------------------

insert into t values ('whole', pg_temp.courier_order('part-whole-0001', 'PART-WHOLE-1', 'in_transit'));
insert into t values ('whole_ret', (public.record_delivery_failure_by_tracking('PART-WHOLE-1', 'refused_unopened')).id);

select public.receive_return(
  (select v from t where k = 'whole_ret'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'whole_ret'), 'PART-A'), 'quantity_resellable', 1),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'whole_ret'), 'PART-B'), 'quantity_resellable', 2)));

select is(
  (select fulfillment_status::text from public.orders where id = (select v from t where k = 'whole')),
  'returned',
  'Refused whole, the order is returned as it always was'
);

-- --- Paid online, refused in part: the refused piece is owed back ----------------

insert into t values ('card', pg_temp.courier_order('part-card-0001', 'PART-CARD-1', 'in_transit', 'card'));
insert into t values ('card_ret', (public.record_delivery_failure_by_tracking('PART-CARD-1', 'refused_after_inspection')).id);

select public.receive_return(
  (select v from t where k = 'card_ret'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'card_ret'), 'PART-A'), 'quantity_kept', 1),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'card_ret'), 'PART-B'),
                       'quantity_resellable', 1, 'quantity_kept', 1)));

select is(
  (select row(value_egp, refund_egp)::text from public.returns where id = (select v from t where k = 'card_ret')),
  '(300.00,300.00)',
  'Paid for online, the refused B is owed back to the customer'
);

-- --- Returned after delivery, by courier --------------------------------------
--
-- Delivered by Accurate, cash at the door: the customer has paid even while
-- the courier holds the money.

insert into t values ('after', pg_temp.courier_order('part-after-0001', 'PART-AFTER-1', 'delivered'));

select is(
  (select public.lookup_return_by_order_number(order_number) ->> 'state' from public.orders where id = (select v from t where k = 'after')),
  'needs_post_delivery_record',
  'A delivered order can be returned'
);

select is(
  (select (public.lookup_return_by_order_number(order_number) ->> 'refunded')::boolean from public.orders where id = (select v from t where k = 'after')),
  true,
  'And what comes back is owed to the customer, who paid the courier'
);

insert into t values ('after_ret1', (public.start_post_delivery_return((select v from t where k = 'after'), 'wrong_size')).id);

select public.receive_return(
  (select v from t where k = 'after_ret1'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'after_ret1'), 'PART-A'), 'quantity_resellable', 1),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'after_ret1'), 'PART-B'), 'quantity_kept', 2)));

select is(
  (select fulfillment_status::text from public.orders where id = (select v from t where k = 'after')),
  'delivered',
  'One piece back of three, the order stays delivered'
);

select is(
  (select row(returned_off_egp, return_refund_owed_egp, is_closed)::text
     from public.v_order_list where id = (select v from t where k = 'after')),
  '(0.00,500.00,f)',
  'The A is owed back, nothing comes off the courier''s money, and the order is not finished'
);

select is(
  public.settlement_goods((select id from public.shipments where tracking_number = 'PART-AFTER-1')),
  1100.00::numeric,
  'The courier still collected for everything'
);

select is(
  (select jsonb_agg(jsonb_build_array(l ->> 'sku', (l ->> 'quantity')::int))
     from public.orders o, jsonb_array_elements(public.lookup_return_by_order_number(o.order_number) -> 'order_lines') l
    where o.id = (select v from t where k = 'after')),
  '[["PART-B", 2]]'::jsonb,
  'Looked up again, only the Bs are still with the customer'
);

select is(
  (select public.lookup_return_by_order_number(order_number) ->> 'state' from public.orders where id = (select v from t where k = 'after')),
  'needs_post_delivery_record',
  'And they can come back too'
);

insert into t values ('after_ret2', (public.start_post_delivery_return((select v from t where k = 'after'), 'not_as_expected')).id);

select is(
  (select count(*)::int from public.return_lines where return_id = (select v from t where k = 'after_ret2')),
  1,
  'The second return expects only the Bs'
);

select public.receive_return(
  (select v from t where k = 'after_ret2'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'after_ret2'), 'PART-B'),
                       'quantity_resellable', 1, 'quantity_damaged', 1)));

select is(
  (select fulfillment_status::text from public.orders where id = (select v from t where k = 'after')),
  'returned',
  'Every piece back, the order is returned'
);

select is(
  (select return_refund_owed_egp from public.v_order_list where id = (select v from t where k = 'after')),
  1100.00::numeric,
  'Both returns are owed back'
);

select throws_ok(
  format($$ select public.start_post_delivery_return(%L, 'wrong_size') $$, (select v from t where k = 'after')),
  null, null,
  'Nothing is left to return'
);

select lives_ok(
  format($$ select public.mark_return_refunded(%L) $$, (select v from t where k = 'after')),
  'Paying it back is recorded'
);

select is(
  (select row(return_refund_owed_egp, return_refunded_egp, is_closed)::text
     from public.v_order_list where id = (select v from t where k = 'after')),
  '(0,1100.00,t)',
  'Nothing is owed back now, and the order is finished'
);

select throws_ok(
  format($$ select public.mark_return_refunded(%L) $$, (select v from t where k = 'after')),
  '23514', null,
  'Paying it back twice is refused'
);

select is(
  (select (details ->> 'amount_egp')::numeric from public.order_events
    where order_id = (select v from t where k = 'after') and event_type = 'return_refunded'),
  1100.00::numeric,
  'The history says how much was paid back'
);

-- --- Returned after delivery, on a tab -----------------------------------------

insert into t values ('tab', (public.create_store_sale(
  p_location_id => 'b1b1b1b1-0000-0000-0000-000000000001',
  p_payment_method => 'deferred',
  p_items => '[{"variant_id":"b1b1b1b1-0000-0000-0000-00000000000a","quantity":1},
               {"variant_id":"b1b1b1b1-0000-0000-0000-00000000000b","quantity":1}]'::jsonb,
  p_idempotency_key => 'part-tab-0001')).id);
update public.orders set fulfillment_status = 'delivered' where id = (select v from t where k = 'tab');

insert into t values ('tab_ret', (public.start_post_delivery_return((select v from t where k = 'tab'), 'wrong_size')).id);

select public.receive_return(
  (select v from t where k = 'tab_ret'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'tab_ret'), 'PART-A'), 'quantity_resellable', 1),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'tab_ret'), 'PART-B'), 'quantity_kept', 1)));

select is(
  (select row(returned_off_egp, return_refund_owed_egp)::text
     from public.v_order_list where id = (select v from t where k = 'tab')),
  '(500.00,0.00)',
  'On a tab nothing is owed back: the customer simply owes 500 less'
);

-- --- #1497: kept in part, first checked in as short, then paid by the statement ---
--
-- A cash parcel; the customer kept the Bs and refused the A. It was checked in
-- before "kept" existed: the A back, the Bs left as missing, the order
-- returned. Accurate's statement then marked it paid for what was collected.
-- Checked in again with the Bs kept, nothing is owed back - the customer paid
-- only for the Bs - and the stock does not move again.

insert into t values ('p1497', pg_temp.courier_order('part-1497-0001', 'PART-1497', 'in_transit'));
insert into t values ('p1497_ret', (public.record_delivery_failure_by_tracking('PART-1497', 'wrong_size')).id);

select public.receive_return(
  (select v from t where k = 'p1497_ret'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'p1497_ret'), 'PART-A'), 'quantity_resellable', 1),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'p1497_ret'), 'PART-B'), 'quantity_resellable', 0)));

update public.orders set payment_status = 'paid' where id = (select v from t where k = 'p1497');

create temporary table s1497 on commit drop as select pg_temp.stock('PART-A') as a, pg_temp.stock('PART-B') as b;

select public.receive_return(
  (select v from t where k = 'p1497_ret'),
  jsonb_build_array(
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'p1497_ret'), 'PART-A'), 'quantity_resellable', 1),
    jsonb_build_object('return_line_id', pg_temp.rline((select v from t where k = 'p1497_ret'), 'PART-B'), 'quantity_kept', 2)));

select is(
  (select fulfillment_status::text from public.orders where id = (select v from t where k = 'p1497')),
  'delivered',
  'Checked in again with the Bs kept, the order is delivered of them'
);

select is(
  (select status::text from public.returns where id = (select v from t where k = 'p1497_ret')),
  'received',
  'And the Bs are no longer missing'
);

select is(
  (select refund_egp from public.returns where id = (select v from t where k = 'p1497_ret')),
  0.00::numeric,
  'Paid by the statement for what was kept, the refused A is not owed back'
);

select is(
  public.settlement_goods((select id from public.shipments where tracking_number = 'PART-1497')),
  600.00::numeric,
  'The statement should have collected for the Bs alone'
);

select is(
  (select row(pg_temp.stock('PART-A'), pg_temp.stock('PART-B'))::text),
  (select row(a, b)::text from s1497),
  'Checking it in again moved no stock'
);

select * from finish();
rollback;
