-- ---------------------------------------------------------------------------
-- Courier settlements: entering the statement by hand, and the checks that
-- make entering it worth the effort.
-- ---------------------------------------------------------------------------

begin;
select plan(36);

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
--
-- It fills in the GOODS, not what the customer handed over. Accurate keeps
-- the shipping fee the customer pays at the door, so on a 1,000 tee with 70
-- shipping the customer pays 1,070, Accurate keeps the 70, and 1,000 reaches
-- the bank. The 70 was never Duch's money, and there is no courier fee to
-- deduct from a delivered parcel because the customer already paid it.
select is(
  (select (public.add_settlement_line(
     'b2b2b2b2-0000-0000-0000-0000000000f1', 'ACC-SETTLE-0001', 'delivered', null, 0
   )).collected_egp),
  1000.00::numeric,
  'A delivered line pre-fills the goods value, not what the customer handed over'
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
  'The delivered order brought in the goods value'
);

-- A refusal collects nothing and still costs a full shipping fee. This one
-- is a real cost to Duch: nobody paid it at a door, so unlike a delivered
-- parcel it genuinely comes off the transfer.
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

-- Scoped to this statement. The view rolls up by month across everything, so
-- asserting a bare figure on it would only pass on an empty database - and
-- would then break the first time anyone else's data shared the month.
select is(
  (select sum(-sl.net_egp)
     from public.settlement_lines sl
    where sl.settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'
      and sl.outcome <> 'delivered'
      and sl.net_egp < 0),
  70.00::numeric,
  'The refusal shows up as a real, countable cost'
);

-- And the monthly view agrees with the lines underneath it, whatever else is
-- in the month.
select is(
  (select cost_egp from public.v_refusal_costs
    where outcome = 'returned_refused'
      and month = date_trunc('month', current_date)::date),
  (select sum(-sl.net_egp)
     from public.settlement_lines sl
     join public.courier_settlements s on s.id = sl.settlement_id
    where sl.outcome = 'returned_refused'
      and sl.net_egp < 0
      and date_trunc('month', s.received_at)::date = date_trunc('month', current_date)::date),
  'And the monthly rollup matches the lines it is built from'
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

-- --- Correcting a statement while it is still a draft ---------------------
--
-- The statement is typed in by hand from their paper, so mis-keying a fee is
-- normal and has to be fixable without starting over.

insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status,
  location_id, payment_method, subtotal_egp, shipping_egp, total_egp
)
values (
  'b2b2b2b2-0000-0000-0000-0000000000a3', public.next_order_number('online'), 'online',
  'delivered', 'pending', 'b2b2b2b2-0000-0000-0000-000000000001', 'cod', 500, 70, 500
);

insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
values ('b2b2b2b2-0000-0000-0000-0000000000a3', 'b2b2b2b2-0000-0000-0000-000000000003',
        'SETTLE-TEE', 'Settle Tee', 1, 500, 500);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at, delivered_at)
values ('b2b2b2b2-0000-0000-0000-0000000000a3', 'ACC-SETTLE-0003', 'outbound', 'delivered',
        570, now() - interval '9 days', now() - interval '6 days');

select isnt_empty(
  $$ select order_id from public.v_awaiting_settlement
      where tracking_number = 'ACC-SETTLE-0003' $$,
  'A delivered order that is on no statement shows as money still owed to us'
);

insert into public.courier_settlements (id, reference, received_at, net_received_egp)
values ('b2b2b2b2-0000-0000-0000-0000000000f2', 'ACC-STMT-9002', current_date, 500);

select is(
  (select (public.add_settlement_line(
     'b2b2b2b2-0000-0000-0000-0000000000f2', 'ACC-SETTLE-0003', 'delivered', null, 0
   )).net_egp),
  500.00::numeric,
  'A delivered line brings in the goods value'
);

select throws_ok(
  $$ select public.add_settlement_line(
       'b2b2b2b2-0000-0000-0000-0000000000f2', 'ACC-SETTLE-0003', 'delivered', null, 70
     ) $$,
  '23505',
  null,
  'Keying the same parcel twice is refused, which is the likely slip on a long statement'
);

select is(
  (select (public.update_settlement_line(
     (select id from public.settlement_lines where tracking_number = 'ACC-SETTLE-0003'),
     null, null, 100
   )).net_egp),
  400.00::numeric,
  'A mis-keyed fee can be corrected in place'
);

select is_empty(
  $$ select order_id from public.v_awaiting_settlement
      where tracking_number = 'ACC-SETTLE-0003' $$,
  'Once it is on a statement it stops showing as owed'
);

select lives_ok(
  $$ select public.remove_settlement_line(
       (select id from public.settlement_lines where tracking_number = 'ACC-SETTLE-0003')
     ) $$,
  'And a line added by mistake can be taken off again'
);

-- --- A reviewed statement is closed ----------------------------------------

select throws_ok(
  $$ select public.add_settlement_line(
       'b2b2b2b2-0000-0000-0000-0000000000f1', 'ACC-SETTLE-0003', 'delivered', null, 0
     ) $$,
  '23514',
  null,
  'Nothing can be added to a statement that has already been signed off'
);

-- --- What the money was for -----------------------------------------------
--
-- The accountant records products and prices, not order numbers. The rollup
-- has to tie out: goods less what the courier charged equals the transfer.
-- Shipping is not in it at all - the customer paid it at the door and
-- Accurate kept it, so it never reaches the transfer being reconciled.

select is(
  (select title from public.v_settlement_products
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  'Settle Tee',
  'A statement knows which products the money came from'
);

select is(
  (select quantity from public.v_settlement_products
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  1,
  'With the quantity sold, which is what he writes in the ledger'
);

select is(
  (select goods_egp from public.v_settlement_breakdown
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  1000.00::numeric,
  'The goods value counts only the deliveries - a refusal brought nothing in'
);

select is(
  (select goods_egp - fees_egp from public.v_settlement_breakdown
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  (select net_egp from public.v_settlement_breakdown
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  'Goods less the courier charges equals the transfer'
);

select is(
  (select collection_difference_egp from public.v_settlement_breakdown
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f1'),
  0.00::numeric,
  'And nothing is left unaccounted for'
);

-- --- Checking a parcel before entering it ----------------------------------

select is(
  (public.lookup_shipment_for_settlement('ACC-SETTLE-0001') #>> '{items,0,title}'),
  'Settle Tee',
  'Typing a code shows what was in that parcel, to check against their paper'
);

select is(
  public.lookup_shipment_for_settlement('ACC-SETTLE-0001') ->> 'already_on',
  'ACC-STMT-9001',
  'And says so if the parcel is already on another statement'
);

select is(
  (public.lookup_shipment_for_settlement('NOT-A-REAL-CODE') ->> 'found')::boolean,
  false,
  'An unknown code says so rather than silently matching nothing'
);

-- --- Charges that belong to no parcel -------------------------------------
--
-- A statement is not only a list of parcels: it carries packaging charges, a
-- fee for handling returns, a correction for something they got wrong last
-- month. Without somewhere to put those, a statement cannot be balanced, and
-- an unbalanced statement cannot be closed at all.

select is(
  (select (public.add_settlement_adjustment(
     'b2b2b2b2-0000-0000-0000-0000000000f2', 'packaging', -200
   )).net_egp),
  -200.00::numeric,
  'A deduction comes off the statement'
);

select is(
  (select (public.add_settlement_adjustment(
     'b2b2b2b2-0000-0000-0000-0000000000f2', 'correction for last month', 80
   )).net_egp),
  80.00::numeric,
  'And a credit goes on it'
);

-- Both columns are constrained non-negative, so the sign has to pick the
-- column. Getting that wrong would silently flip a deduction into income.
select is(
  (select fee_egp from public.settlement_lines
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f2' and note = 'packaging'),
  200.00::numeric,
  'A deduction is recorded as a fee, not as a negative collection'
);

select throws_ok(
  $$ select public.add_settlement_adjustment(
       'b2b2b2b2-0000-0000-0000-0000000000f2', '   ', -50
     ) $$,
  '22023',
  null,
  'An unlabelled deduction is refused - it is the one nobody can explain later'
);

-- An adjustment has no order on purpose. Counting it as an unmatched parcel
-- would turn a real warning - a code that matched nothing - into noise.
select is(
  (select unmatched_lines from public.v_settlement_totals
    where settlement_id = 'b2b2b2b2-0000-0000-0000-0000000000f2'),
  0::bigint,
  'An adjustment is not mistaken for a parcel nobody could match'
);

-- A charge for packaging is not the cost of a refused delivery. Refusal cost
-- is the number this business watches hardest, and letting other courier
-- charges leak into it would overstate it by whatever they billed that month.
select is(
  (select count(*)::int from public.v_refusal_costs where outcome = 'adjustment'),
  0,
  'An adjustment never counts as a refusal cost'
);

select * from finish();
rollback;
