-- ---------------------------------------------------------------------------
-- Courier settlements: entering the statement by hand, and the checks that
-- make entering it worth the effort.
-- ---------------------------------------------------------------------------

begin;
select plan(14);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_active)
values ('b2b2b2b2-0000-0000-0000-000000000001', 'Settle Test Shop', 'store', true);

insert into public.products (id, title)
values ('b2b2b2b2-0000-0000-0000-000000000002', 'Settle Tee');

insert into public.variants (id, product_id, sku, price_egp)
values ('b2b2b2b2-0000-0000-0000-000000000003',
        'b2b2b2b2-0000-0000-0000-000000000002', 'SETTLE-TEE', 1000.00);

insert into auth.users (id, email, aud, role) values
  ('b2b2b2b2-0000-0000-0000-00000000000a', 'settle-sales@test.local', 'authenticated', 'authenticated');
update public.staff set role = 'sales', is_active = true
 where id = 'b2b2b2b2-0000-0000-0000-00000000000a';

select public.record_stock_movements(
  'b2b2b2b2-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"b2b2b2b2-0000-0000-0000-000000000003","quantity_delta":20}]'::jsonb
);

-- Two COD orders: one that gets delivered, one that gets refused. Each is
-- 1000 for the goods plus 70 shipping, so the courier collects 1070 at the door.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status,
  location_id, payment_method, subtotal_egp, shipping_egp, total_egp
)
values
  ('b2b2b2b2-0000-0000-0000-0000000000a1', public.next_order_number('online'), 'online',
   'in_transit', 'pending', 'b2b2b2b2-0000-0000-0000-000000000001', 'cod', 1000, 70, 1000),
  ('b2b2b2b2-0000-0000-0000-0000000000a2', public.next_order_number('online'), 'online',
   'in_transit', 'pending', 'b2b2b2b2-0000-0000-0000-000000000001', 'cod', 1000, 70, 1000);

insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
values
  ('b2b2b2b2-0000-0000-0000-0000000000a1', 'b2b2b2b2-0000-0000-0000-000000000003',
   'SETTLE-TEE', 'Settle Tee', 1, 1000, 1000),
  ('b2b2b2b2-0000-0000-0000-0000000000a2', 'b2b2b2b2-0000-0000-0000-000000000003',
   'SETTLE-TEE', 'Settle Tee', 1, 1000, 1000);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at)
values
  ('b2b2b2b2-0000-0000-0000-0000000000a1', 'ACC-SETTLE-0001', 'outbound', 'delivered', 1070, now() - interval '5 days'),
  ('b2b2b2b2-0000-0000-0000-0000000000a2', 'ACC-SETTLE-0002', 'outbound', 'returned', 1070, now() - interval '5 days');

update public.orders set fulfillment_status = 'delivered'
 where id = 'b2b2b2b2-0000-0000-0000-0000000000a1';

-- --- Entering the statement ------------------------------------------------

insert into public.courier_settlements (id, reference, statement_date, received_at, net_received_egp)
values ('b2b2b2b2-0000-0000-0000-0000000000f1', 'ACC-STMT-9001',
        current_date, current_date, 900.00);

-- A delivered line needs only the courier's code: the CRM already knows what
-- that parcel was worth, so the collected amount fills itself in.
select is(
  (select (public.add_settlement_line(
     'b2b2b2b2-0000-0000-0000-0000000000f1', 'ACC-SETTLE-0001', 'delivered', null, 70
   )).collected_egp),
  1070.00::numeric,
  'A delivered line pre-fills the amount the courier should have collected'
);

select is(
  (select order_id from public.settlement_lines
    where tracking_number = 'ACC-SETTLE-0001'),
  'b2b2b2b2-0000-0000-0000-0000000000a1'::uuid,
  'The courier code resolved to our order without anyone typing an order number'
);

select is(
  (select net_egp from public.settlement_lines where tracking_number = 'ACC-SETTLE-0001'),
  1000.00::numeric,
  'Net of the courier fee, the delivered order brought in the goods value'
);

-- A refusal collects nothing and still costs a full shipping fee.
select is(
  (select (public.add_settlement_line(
     'b2b2b2b2-0000-0000-0000-0000000000f1', 'ACC-SETTLE-0002', 'returned_refused', null, 70
   )).net_egp),
  -70.00::numeric,
  'A refused delivery is money out, not merely money not in'
);

select is(
  (select net_egp from public.v_settlement_totals
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  930.00::numeric,
  'The lines add up to what should have arrived'
);

select is(
  (select difference_egp from public.v_settlement_totals
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  -30.00::numeric,
  'And the gap against the bank transfer is shown rather than buried'
);

-- --- It will not close while it does not balance ---------------------------

select throws_ok(
  $$ select public.review_settlement('b2b2b2b2-0000-0000-0000-0000000000f1') $$,
  '23514',
  null,
  'A settlement that does not balance cannot be signed off'
);

select is(
  (select payment_status::text from public.orders
    where id = 'b2b2b2b2-0000-0000-0000-0000000000a1'),
  'pending',
  'And nothing was marked paid on the way to failing'
);

-- --- Balanced, so it closes ------------------------------------------------

update public.courier_settlements set net_received_egp = 930.00
 where id = 'b2b2b2b2-0000-0000-0000-0000000000f1';

select is(
  (select (public.review_settlement('b2b2b2b2-0000-0000-0000-0000000000f1')
           ->> 'orders_marked_paid')::int),
  1,
  'Reviewing a balanced settlement marks the delivered order paid'
);

select is(
  (select payment_status::text from public.orders
    where id = 'b2b2b2b2-0000-0000-0000-0000000000a1'),
  'paid',
  'The delivered order is finally paid - a week after it was delivered'
);

select is(
  (select payment_status::text from public.orders
    where id = 'b2b2b2b2-0000-0000-0000-0000000000a2'),
  'pending',
  'The refused order was never paid for and stays that way'
);

select throws_ok(
  $$ select public.review_settlement('b2b2b2b2-0000-0000-0000-0000000000f1') $$,
  '23514',
  null,
  'A settlement cannot be reviewed twice'
);

-- --- What it cost ----------------------------------------------------------

select is(
  (select cost_egp from public.v_refusal_costs
    where outcome = 'returned_refused'),
  70.00::numeric,
  'The refusal shows up as a real, countable cost'
);

-- --- Money is not for everyone ---------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"b2b2b2b2-0000-0000-0000-00000000000a"}';

select is_empty(
  $$ select id from public.courier_settlements $$,
  'A sales user cannot see the courier settlements at all'
);

reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
