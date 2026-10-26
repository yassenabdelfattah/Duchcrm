-- ---------------------------------------------------------------------------
-- Statements (2026-10-26): what Accurate wrote against what the CRM knows, a
-- closed statement reopened and corrected, and our own driver kept off the
-- list of parcels waiting for Accurate's money.
-- ---------------------------------------------------------------------------

begin;
select plan(25);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_active)
values ('a7a7a7a7-0000-0000-0000-000000000001', 'Check Test Shop', 'store', true);

insert into auth.users (id, email, aud, role) values
  ('a7a7a7a7-0000-0000-0000-00000000000a', 'check-sales@test.local', 'authenticated', 'authenticated');
update public.staff set role = 'sales', is_active = true
 where id = 'a7a7a7a7-0000-0000-0000-00000000000a';

-- 1000 of goods each, 70 shipping.
--   a1 delivered, and Accurate says delivered
--   a2 still with the courier here, and Accurate says it came back
--   a3 delivered here, and Accurate says it came back
--   a4 still with the courier here, and Accurate says delivered
--   a5 delivered and already paid some other way
--   a6 returned, not on a statement yet; a7 the same, with our own driver
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status,
  location_id, payment_method, subtotal_egp, shipping_egp, total_egp
)
select ('a7a7a7a7-0000-0000-0000-0000000000a' || n)::uuid, 'CHECK-' || n, 'online',
       (array['delivered', 'in_transit', 'delivered', 'in_transit', 'delivered', 'returned', 'returned'])[n]::public.fulfillment_status,
       (case when n = 5 then 'paid' else 'pending' end)::public.payment_status,
       'a7a7a7a7-0000-0000-0000-000000000001', 'cod', 1000, 70, 1000
  from generate_series(1, 7) n;

insert into public.shipments (order_id, courier, tracking_number, direction, status, cod_amount_egp, handed_over_at)
select ('a7a7a7a7-0000-0000-0000-0000000000a' || n)::uuid,
       case when n = 7 then 'own' else 'accurate' end,
       case when n = 7 then null else 'ACC-CHECK-' || n end,
       'outbound',
       (array['delivered', 'in_transit', 'delivered', 'in_transit', 'delivered', 'returned', 'returned'])[n]::public.shipment_status,
       1070, now() - interval '5 days'
  from generate_series(1, 7) n;

insert into public.courier_settlements (id, reference, statement_date, received_at, net_received_egp)
values ('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-STMT', current_date, current_date, 2860.00);

select public.add_settlement_line('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-1', 'delivered');
select public.add_settlement_line('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-2', 'returned_other', null, 70);
select public.add_settlement_line('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-3', 'returned_refused', null, 70);
select public.add_settlement_line('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-4', 'delivered');
select public.add_settlement_line('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-5', 'delivered', p_note => 'checked by phone');

create temporary table line_of (n int, line_id uuid) on commit drop;
insert into line_of
select substr(tracking_number, 11)::int, line_id
  from public.v_settlement_statement
 where settlement_id = 'a7a7a7a7-0000-0000-0000-0000000000f1';

-- --- Where the two disagree --------------------------------------------------

select is(
  (select mismatch from public.v_settlement_statement where tracking_number = 'ACC-CHECK-1'),
  null,
  'Delivered on both sides: nothing to say'
);

select is(
  (select mismatch from public.v_settlement_statement where tracking_number = 'ACC-CHECK-2'),
  'not_back',
  'Returned on the statement and not checked in: not back with us'
);

select is(
  (select mismatch from public.v_settlement_statement where tracking_number = 'ACC-CHECK-3'),
  'crm_delivered',
  'Returned on the statement and delivered in the CRM: one of them is wrong'
);

select is(
  (select mismatch from public.v_settlement_statement where tracking_number = 'ACC-CHECK-4'),
  'crm_not_delivered',
  'Delivered on the statement and still out in the CRM'
);

-- --- Closing ------------------------------------------------------------------

select is(
  (public.review_settlement('a7a7a7a7-0000-0000-0000-0000000000f1') ->> 'orders_marked_paid')::int,
  2,
  'Closing pays the two deliveries that were unpaid'
);

select is(
  (select array_agg(n order by n) from line_of
     join public.settlement_lines sl on sl.id = line_of.line_id
    where sl.marked_paid),
  array[1, 4],
  'And each line remembers whether it was the one that paid its order'
);

-- --- Reopening ------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7a7a7a7-0000-0000-0000-00000000000a"}';

select throws_ok(
  $$ select public.reopen_settlement('a7a7a7a7-0000-0000-0000-0000000000f1') $$,
  '42501', null,
  'Only someone who manages statements can reopen one'
);

select set_config('request.jwt.claims', '', true);
reset role;

select lives_ok(
  $$ select public.reopen_settlement('a7a7a7a7-0000-0000-0000-0000000000f1') $$,
  'A closed statement can be reopened'
);

select is(
  (select row(status::text, reviewed_at is null, reopened_at is not null)::text
     from public.courier_settlements where id = 'a7a7a7a7-0000-0000-0000-0000000000f1'),
  row('draft', true, true)::text,
  'It is open again, and when it was reopened is kept'
);

select throws_ok(
  $$ select public.reopen_settlement('a7a7a7a7-0000-0000-0000-0000000000f1') $$,
  '23514', null,
  'An open statement cannot be reopened'
);

select is(
  (select payment_status::text from public.orders where id = 'a7a7a7a7-0000-0000-0000-0000000000a1'),
  'paid',
  'What it paid stays paid while it is open'
);

-- --- Correcting -------------------------------------------------------------------

select public.remove_settlement_line((select line_id from line_of where n = 5));

select is(
  (select payment_status::text from public.orders where id = 'a7a7a7a7-0000-0000-0000-0000000000a5'),
  'paid',
  'Taking off an order paid some other way leaves it paid'
);

select public.update_settlement_line((select line_id from line_of where n = 4), 'returned_other');

select is(
  (select row(sl.collected_egp, sl.marked_paid, o.payment_status::text)::text
     from public.settlement_lines sl join public.orders o on o.id = sl.order_id
    where sl.id = (select line_id from line_of where n = 4)),
  row(0.00::numeric(12, 2), false, 'pending')::text,
  'A delivery corrected to a return collected nothing, and its order is unpaid again'
);

select public.remove_settlement_line((select line_id from line_of where n = 1));

select is(
  (select payment_status::text from public.orders where id = 'a7a7a7a7-0000-0000-0000-0000000000a1'),
  'pending',
  'Taking off a delivery this statement paid makes its order unpaid again'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'a7a7a7a7-0000-0000-0000-0000000000a1'
      and from_payment = 'paid' and to_payment = 'pending'),
  1,
  'And its history says so'
);

select public.update_settlement_line((select line_id from line_of where n = 2), p_fee_egp => 80);

select is(
  (select row(outcome::text, collected_egp, fee_egp)::text from public.settlement_lines
    where id = (select line_id from line_of where n = 2)),
  row('returned_other', 0.00::numeric(12, 2), 80.00::numeric(12, 2))::text,
  'Changing the fee alone leaves the rest of the line as it was'
);

-- --- Closing again ------------------------------------------------------------------

select public.add_settlement_line('a7a7a7a7-0000-0000-0000-0000000000f1', 'ACC-CHECK-1', 'delivered');
update public.courier_settlements set net_received_egp = 780.00
 where id = 'a7a7a7a7-0000-0000-0000-0000000000f1';

select is(
  (public.review_settlement('a7a7a7a7-0000-0000-0000-0000000000f1') ->> 'orders_marked_paid')::int,
  1,
  'Closed again, it pays what is on it now'
);

select is(
  (select array_agg(o.order_number::text order by o.order_number) from public.orders o
    where o.id::text like 'a7a7a7a7-%' and o.payment_status = 'paid'),
  array['CHECK-1', 'CHECK-5'],
  'Paid: the delivery on it, and the order paid some other way'
);

-- --- Paid online ------------------------------------------------------------------------

-- InstaPay before it left, not yet confirmed: Accurate collects nothing and
-- charges 80 to carry it.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status,
  location_id, payment_method, subtotal_egp, shipping_egp, total_egp
) values (
  'a7a7a7a7-0000-0000-0000-0000000000a8', 'CHECK-8', 'online', 'delivered', 'pending',
  'a7a7a7a7-0000-0000-0000-000000000001', 'instapay', 1240, 80, 1240
);
insert into public.order_line_items (order_id, sku, title, quantity, unit_price_egp, total_egp)
values ('a7a7a7a7-0000-0000-0000-0000000000a8', 'CHECK-TEE', 'Check Tee', 1, 1240, 1240);
insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at)
values ('a7a7a7a7-0000-0000-0000-0000000000a8', 'ACC-CHECK-8', 'outbound', 'delivered', 0, now() - interval '3 days');

insert into public.courier_settlements (id, reference, statement_date, received_at, net_received_egp)
values ('a7a7a7a7-0000-0000-0000-0000000000f2', 'ACC-CHECK-STMT-2', current_date, current_date, -80.00);

select is(
  (public.lookup_shipment_for_settlement('ACC-CHECK-8') ->> 'expected_egp')::numeric,
  0::numeric,
  'A parcel paid online is expected to bring nothing in'
);

select is(
  (select row(collected_egp, fee_egp, net_egp)::text from public.add_settlement_line(
     'a7a7a7a7-0000-0000-0000-0000000000f2', 'ACC-CHECK-8', 'delivered', null, 80)),
  row(0.00::numeric(12, 2), 80.00::numeric(12, 2), -80.00::numeric(12, 2))::text,
  'Delivered, it collected nothing and cost the shipping'
);

select is(
  (select count(*)::int from public.v_settlement_products
    where settlement_id = 'a7a7a7a7-0000-0000-0000-0000000000f2'),
  0,
  'Its products are not what this transfer paid for'
);

select is(
  (public.review_settlement('a7a7a7a7-0000-0000-0000-0000000000f2') ->> 'orders_marked_paid')::int,
  0,
  'And the transfer does not prove it paid'
);

-- --- Waiting for Accurate's money ------------------------------------------------------

select is(
  (select count(*)::int from public.v_awaiting_settlement where order_id = 'a7a7a7a7-0000-0000-0000-0000000000a6'),
  1,
  'A parcel Accurate brought back is waiting for their statement'
);

select is(
  (select count(*)::int from public.v_awaiting_settlement where order_id = 'a7a7a7a7-0000-0000-0000-0000000000a7'),
  0,
  'One our own driver brought back is not'
);

select is(
  (select count(*)::int from public.v_awaiting_settlement where order_id = 'a7a7a7a7-0000-0000-0000-0000000000a4'),
  0,
  'Nor one already on a statement, even as a return'
);

select * from finish();
rollback;
