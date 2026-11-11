-- ---------------------------------------------------------------------------
-- Profit: costs, spending, and what the courier cost.
--
-- What matters: only profit.view reads or writes any of it - the reports
-- permission alone sees nothing; a cost sheet saved again for its date is
-- replaced and one for a new date is kept beside it; the courier's cost per
-- parcel is the fee less what the customer paid for shipping, so a delivery
-- that agrees costs nothing, and a refusal, a no-answer, free shipping and a
-- fee gap each cost what they should; and the gift fund buying from the shelf
-- takes the pieces out once.
-- ---------------------------------------------------------------------------

begin;
select plan(22);

insert into public.roles (id, name_ar, permissions) values
  ('f8f8f8f8-0000-0000-0000-0000000000e1', 'أرباح تجريبي', array['profit.view', 'stock.adjust']),
  ('f8f8f8f8-0000-0000-0000-0000000000e2', 'تقارير بلا أرباح تجريبي', array['reports.read', 'products.manage', 'orders.read']);
insert into auth.users (id, email, aud, role) values
  ('f8f8f8f8-0000-0000-0000-00000000000a', 'profit-owner@test.local', 'authenticated', 'authenticated'),
  ('f8f8f8f8-0000-0000-0000-00000000000b', 'profit-none@test.local', 'authenticated', 'authenticated');
update public.staff set role_id = 'f8f8f8f8-0000-0000-0000-0000000000e1', is_active = true where id = 'f8f8f8f8-0000-0000-0000-00000000000a';
update public.staff set role_id = 'f8f8f8f8-0000-0000-0000-0000000000e2', is_active = true where id = 'f8f8f8f8-0000-0000-0000-00000000000b';

insert into public.products (id, title) values ('f8f8f8f8-0000-0000-0000-000000000002', 'Profit Test Hoodie');
insert into public.variants (id, product_id, sku, size, color, price_egp) values
  ('f8f8f8f8-0000-0000-0000-0000000000a1', 'f8f8f8f8-0000-0000-0000-000000000002', 'PT-HOOD-M', 'M', 'Black', 1000),
  ('f8f8f8f8-0000-0000-0000-0000000000a2', 'f8f8f8f8-0000-0000-0000-000000000002', 'PT-HOOD-XL', 'XL', 'Black', 1000);
insert into public.stock_levels (variant_id, location_id, quantity)
select 'f8f8f8f8-0000-0000-0000-0000000000a1', id, 5 from public.locations where is_default;

-- An order of one piece at 1,000 with 80 shipping, its parcel, and its line
-- on a statement.
create or replace function pg_temp.parcel(p_n int, p_status text, p_shipping numeric, p_cod numeric,
                                          p_statement uuid, p_outcome text, p_collected numeric, p_fee numeric, p_door numeric)
returns void language plpgsql as $$
declare
  v_order uuid := ('f8f8f8f8-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ship  uuid;
begin
  insert into public.orders (id, order_number, channel, fulfillment_status, payment_status, location_id, payment_method,
                             subtotal_egp, discount_egp, shipping_egp, total_egp, created_at)
  values (v_order, 'PT-' || p_n, 'online', p_status::public.fulfillment_status, 'pending',
          (select id from public.locations where is_default), 'cod', 1000, 0, p_shipping, 1000, '2026-10-10 12:00+02');
  insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
  values (v_order, 'f8f8f8f8-0000-0000-0000-0000000000a1', 'PT-HOOD-M', 'Profit Test Hoodie', 1, 1000, 1000);
  insert into public.shipments (order_id, courier, tracking_number, direction, status, cod_amount_egp, handed_over_at)
  values (v_order, 'accurate', 'PT-TRK-' || p_n, 'outbound', 'in_transit', p_cod, now())
  returning id into v_ship;
  insert into public.settlement_lines (settlement_id, order_id, shipment_id, tracking_number, outcome, collected_egp, fee_egp, expected_egp, customer_shipping_egp)
  values (p_statement, v_order, v_ship, 'PT-TRK-' || p_n, p_outcome::public.settlement_outcome, p_collected, p_fee, 1000, p_door);
end;
$$;

insert into public.courier_settlements (id, reference, received_at, status) values
  ('f8f8f8f8-0000-0000-0000-0000000000c1', 'PT-STATEMENT', '2026-10-25', 'reviewed'),
  ('f8f8f8f8-0000-0000-0000-0000000000c2', 'PT-DRAFT', null, 'draft');

--                    n  status       ship  cod   statement                                 outcome                 collected fee  door
select pg_temp.parcel(1, 'delivered', 80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'delivered',            1080,     80,  80);   -- agrees: no cost
select pg_temp.parcel(2, 'delivered', 80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'delivered',            1080,     85,  80);   -- charged 5 more
select pg_temp.parcel(3, 'delivered', 0,    1000, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'delivered',            1000,     80,  0);    -- free shipping
select pg_temp.parcel(4, 'returned',  80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'returned_refused',     0,        80,  80);   -- refused
select pg_temp.parcel(5, 'returned',  80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'returned_no_response', 0,        15,  80);   -- no answer
select pg_temp.parcel(6, 'returned',  80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'returned_refused',     80,       80,  80);   -- paid the shipping, refused the goods
select pg_temp.parcel(7, 'delivered', 80,   0,    'f8f8f8f8-0000-0000-0000-0000000000c1', 'delivered',            0,        80,  0);    -- paid online, shipping too
select pg_temp.parcel(8, 'delivered', 80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c1', 'delivered',            1070,     80,  80);   -- collected 10 short
select pg_temp.parcel(9, 'returned',  80,   1080, 'f8f8f8f8-0000-0000-0000-0000000000c2', 'returned_refused',     0,        80,  80);   -- on a draft

select is(
  (select array_length(public.known_permissions(), 1)), 15,
  'profit.view is a permission a role can be given');

-- --- With the permission -------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f8f8f8f8-0000-0000-0000-00000000000a"}';

select lives_ok(
  $$ select public.save_cost_sheet('f8f8f8f8-0000-0000-0000-000000000002', '2026-10-01', '[
       {"kind":"cost","label":"قماش","amount_egp":120,"overrides":[{"size":"XL","color":null,"amount_egp":140}]},
       {"kind":"cost","label":"تفصيل","amount_egp":60},
       {"kind":"loss_reserve","label":"مخصص الشحن","amount_egp":10},
       {"kind":"gift_reserve","label":"مخصص الهدايا","amount_egp":5}]'::jsonb) $$,
  'Someone with profit.view can save a cost');
select is(
  (select count(*)::int from public.cost_lines l join public.cost_sheets s on s.id = l.sheet_id
    where s.product_id = 'f8f8f8f8-0000-0000-0000-000000000002'),
  4, 'with every line');
select is(
  (select o.amount_egp from public.cost_line_overrides o join public.cost_lines l on l.id = o.line_id
     join public.cost_sheets s on s.id = l.sheet_id
    where s.product_id = 'f8f8f8f8-0000-0000-0000-000000000002' and o.size = 'XL'),
  140.00, 'and the size that differs');

select lives_ok(
  $$ select public.save_cost_sheet('f8f8f8f8-0000-0000-0000-000000000002', '2026-10-01',
       '[{"kind":"cost","label":"قماش","amount_egp":125}]'::jsonb) $$,
  'Saved again for the same date');
select is(
  (select array_agg(l.amount_egp order by l.position) from public.cost_lines l join public.cost_sheets s on s.id = l.sheet_id
    where s.product_id = 'f8f8f8f8-0000-0000-0000-000000000002'),
  array[125.00], 'it replaces the sheet rather than adding to it');

select lives_ok(
  $$ select public.save_cost_sheet('f8f8f8f8-0000-0000-0000-000000000002', '2026-11-10',
       '[{"kind":"cost","label":"قماش","amount_egp":150}]'::jsonb) $$,
  'Saved for a new date');
select is(
  (select count(*)::int from public.cost_sheets where product_id = 'f8f8f8f8-0000-0000-0000-000000000002'),
  2, 'the old cost stays beside the new one');

select throws_ok(
  $$ select public.save_cost_sheet('f8f8f8f8-0000-0000-0000-000000000002', '2026-11-10', '[]'::jsonb) $$,
  '22023', null, 'A cost needs at least one line');
select throws_ok(
  $$ select public.save_cost_sheet('f8f8f8f8-0000-0000-0000-000000000002', '2026-11-10',
       '[{"kind":"cost","label":"قماش","amount_egp":-1}]'::jsonb) $$,
  '22023', null, 'and no line below zero');

select lives_ok(
  $$ insert into public.ad_spend (from_date, to_date, amount_egp) values ('2026-10-01', '2026-10-31', 3100);
     insert into public.expenses (kind, spent_on, category, amount_egp) values ('expense', '2026-10-05', 'إيجار', 500) $$,
  'They can record ads and expenses');

-- What the courier cost, parcel by parcel.
select is(
  (select coalesce(string_agg(order_number || ':' || kind || ':' || cost_egp, ' ' order by order_number, kind), '')
     from public.v_profit_courier where reference = 'PT-STATEMENT'),
  'PT-2:fee_gap:5.00 PT-3:free_shipping:80.00 PT-4:refused:80.00 PT-5:no_response:15.00 PT-8:collection_gap:10.00',
  'A delivery that agrees, a refusal that paid its shipping and a parcel paid online cost nothing; the rest cost what they should');
select is(
  (select counted_on from public.v_profit_courier where order_number = 'PT-4'),
  '2026-10-10'::date, 'on the day the order was placed');
select is(
  (select statement_status from public.v_profit_courier where order_number = 'PT-9'),
  'draft', 'A draft statement''s lines are marked, for the screen to leave out');

-- The gift fund buys two pieces off the shelf.
select lives_ok(
  $$ select public.record_gift_from_stock('2026-10-20', 'giveaway',
       '[{"variant_id":"f8f8f8f8-0000-0000-0000-0000000000a1","quantity":2,"unit_price_egp":300}]'::jsonb, 'profit-test-gift-1') $$,
  'The gift fund can buy pieces from our own stock');
select lives_ok(
  $$ select public.record_gift_from_stock('2026-10-20', 'giveaway',
       '[{"variant_id":"f8f8f8f8-0000-0000-0000-0000000000a1","quantity":2,"unit_price_egp":300}]'::jsonb, 'profit-test-gift-1') $$,
  'A second tap is accepted');
select is(
  (select row(count(*), sum(amount_egp))::text from public.expenses where kind = 'gift' and note = 'giveaway'),
  row(1, 600.00)::text, 'and spends from the fund once, at the price typed in');

reset role;
select is(
  (select quantity from public.stock_levels where variant_id = 'f8f8f8f8-0000-0000-0000-0000000000a1'),
  3, 'with the pieces off the shelf once');

-- --- Without it ------------------------------------------------------------------------------

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8f8f8f8-0000-0000-0000-00000000000b"}';

select is(
  (select (select count(*) from public.cost_sheets) + (select count(*) from public.cost_lines)
        + (select count(*) from public.ad_spend) + (select count(*) from public.expenses)
        + (select count(*) from public.profit_settings) + (select count(*) from public.v_profit_courier))::int,
  0, 'Reports and products without profit.view see no cost, no spending and no courier cost');
select throws_ok(
  $$ select public.save_cost_sheet('f8f8f8f8-0000-0000-0000-000000000002', '2026-12-01',
       '[{"kind":"cost","label":"قماش","amount_egp":1}]'::jsonb) $$,
  '42501', null, 'and cannot save a cost');
select throws_ok(
  $$ insert into public.expenses (kind, spent_on, category, amount_egp) values ('expense', '2026-10-05', 'x', 1) $$,
  '42501', null, 'or record an expense');
select throws_ok(
  $$ select public.record_gift_from_stock('2026-10-20', 'x',
       '[{"variant_id":"f8f8f8f8-0000-0000-0000-0000000000a1","quantity":1,"unit_price_egp":1}]'::jsonb, 'profit-test-gift-2') $$,
  '42501', null, 'or spend from the gift fund');

select * from finish();
rollback;
