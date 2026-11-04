-- ---------------------------------------------------------------------------
-- Net sales count an exchange once, and the money: what came in, and what the
-- couriers hold.
--
-- What matters: a replacement's credit is not a discount, so the old piece
-- comes off once, as a return - 550 hoodie for a 700 jacket nets 700; an
-- exchange whose replacement was cancelled took nothing back; money in is
-- Accurate's reviewed transfers and every other payment, never the same cash
-- twice, less refunds; and the couriers hold what they collected and have not
-- paid on a reviewed statement, and what they are out to collect.
-- ---------------------------------------------------------------------------

begin;
select plan(17);

insert into public.locations (id, name, type, is_default, is_active)
values ('d6d6d6d6-0000-0000-0000-000000000001', 'Money Test Shop', 'store', false, true);

insert into public.products (id, title) values ('d6d6d6d6-0000-0000-0000-000000000002', 'Money Test Piece');
insert into public.variants (id, product_id, sku, size, price_egp) values
  ('d6d6d6d6-0000-0000-0000-00000000000a', 'd6d6d6d6-0000-0000-0000-000000000002', 'MT-HOODIE', 'M', 550),
  ('d6d6d6d6-0000-0000-0000-00000000000b', 'd6d6d6d6-0000-0000-0000-000000000002', 'MT-JACKET', 'L', 700);

-- An order of one piece, inserted as it stands.
create or replace function pg_temp.order_of(p_id text, p_number text, p_status text, p_paid text, p_method text,
                                            p_sku text, p_price numeric, p_discount numeric default 0,
                                            p_shipping numeric default 0, p_exchange_for text default null)
returns uuid language plpgsql as $$
begin
  insert into public.orders (id, order_number, channel, fulfillment_status, payment_status, location_id, payment_method,
                             subtotal_egp, discount_egp, shipping_egp, total_egp, exchange_for_order_id)
  values (p_id::uuid, p_number, 'online', p_status::public.fulfillment_status, p_paid::public.payment_status,
          'd6d6d6d6-0000-0000-0000-000000000001', p_method::public.payment_method,
          p_price, p_discount, p_shipping, p_price - p_discount, p_exchange_for::uuid);
  insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
  values (p_id::uuid, (select id from public.variants where sku = p_sku), p_sku, 'Money Test Piece', 1, p_price, p_price);
  return p_id::uuid;
end;
$$;

create or replace function pg_temp.ship(p_order text, p_courier text, p_status text, p_cod numeric) returns void language sql as $$
  insert into public.shipments (order_id, courier, driver_name, tracking_number, direction, status, cod_amount_egp, handed_over_at)
  values (p_order::uuid, p_courier, case when p_courier = 'own' then 'Mahmoud' end,
          case when p_courier <> 'own' then 'MT-' || right(p_order, 4) end,
          'outbound', p_status::public.shipment_status, p_cod, now() - interval '3 days');
$$;

-- An exchange's old piece coming back: the return, and its one line.
create or replace function pg_temp.exchange_back(p_original text, p_replacement text, p_status text, p_received boolean)
returns void language plpgsql as $$
declare v_return uuid;
begin
  insert into public.returns (order_id, type, reason, status, replacement_order_id, received_at)
  values (p_original::uuid, 'exchange', 'wrong_size', p_status::public.return_status, p_replacement::uuid,
          case when p_received then now() end)
  returning id into v_return;
  insert into public.return_lines (return_id, order_line_item_id, variant_id, sku, quantity_expected, quantity_received, quantity_resellable)
  select v_return, li.id, li.variant_id, li.sku, 1, case when p_received then 1 else 0 end, case when p_received then 1 else 0 end
    from public.order_line_items li where li.order_id = p_original::uuid;
end;
$$;

-- --- An exchange counted once ------------------------------------------------------

-- #1407's shape: a 550 hoodie, exchanged for a 700 jacket; the customer paid 150.
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000a1', 'MT-HOODIE-1', 'delivered', 'paid', 'cod', 'MT-HOODIE', 550);
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000a2', 'MT-SWAP-1', 'delivered', 'paid', 'cod', 'MT-JACKET', 700, 550, 0,
                        'd6d6d6d6-0000-0000-0000-0000000000a1');
select pg_temp.exchange_back('d6d6d6d6-0000-0000-0000-0000000000a1', 'd6d6d6d6-0000-0000-0000-0000000000a2', 'received', true);

select is(
  (select row(gross_egp, discounts_egp, net_egp)::text from public.v_report_lines where order_number = 'MT-SWAP-1'),
  row(700.00, 0.00, 700.00)::text,
  'The replacement is a sale at the jacket''s price: its credit is no discount');
select is(
  (select value_egp from public.v_report_returns where order_number = 'MT-HOODIE-1'),
  550.00, 'The hoodie comes back at what it sold for');
select is(
  (select sum(net_egp) from public.v_report_lines where order_number in ('MT-HOODIE-1', 'MT-SWAP-1'))
    - (select sum(value_egp) from public.v_report_returns where order_number in ('MT-HOODIE-1', 'MT-SWAP-1')),
  700.00, 'Together they net 700: the customer has a 700 jacket and paid 700 for it');

-- The jacket exchanged again: it comes back at 700, not at the 150 its order asked for.
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000a3', 'MT-SWAP-2', 'in_transit', 'pending', 'cod', 'MT-JACKET', 700, 700, 0,
                        'd6d6d6d6-0000-0000-0000-0000000000a2');
select pg_temp.exchange_back('d6d6d6d6-0000-0000-0000-0000000000a2', 'd6d6d6d6-0000-0000-0000-0000000000a3', 'expected', false);
select is(
  (select value_egp from public.v_report_returns where order_number = 'MT-SWAP-1'),
  700.00, 'A replacement''s piece exchanged again comes back at what it sold for');

-- A replacement cancelled before the old piece came back: nothing came back.
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000a4', 'MT-HOODIE-2', 'delivered', 'paid', 'cod', 'MT-HOODIE', 550);
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000a5', 'MT-SWAP-3', 'cancelled', 'pending', 'cod', 'MT-JACKET', 700, 550, 0,
                        'd6d6d6d6-0000-0000-0000-0000000000a4');
update public.orders set cancelled_at = now() where id = 'd6d6d6d6-0000-0000-0000-0000000000a5';
select pg_temp.exchange_back('d6d6d6d6-0000-0000-0000-0000000000a4', 'd6d6d6d6-0000-0000-0000-0000000000a5', 'closed', false);
select is(
  (select count(*)::int from public.v_report_returns where order_number = 'MT-HOODIE-2'),
  0, 'An exchange whose replacement was cancelled took nothing back: no return');

-- --- Money that came in -----------------------------------------------------------------

-- Accurate delivered B1 (collected on a reviewed statement) and B2 (on a draft).
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000b1', 'MT-ACC-1', 'delivered', 'pending', 'cod', 'MT-JACKET', 700, 0, 80);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000b1', 'accurate', 'delivered', 780);
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000b2', 'MT-ACC-2', 'delivered', 'pending', 'cod', 'MT-HOODIE', 550, 0, 80);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000b2', 'accurate', 'delivered', 630);

insert into public.courier_settlements (id, reference, received_at, net_received_egp, status) values
  ('d6d6d6d6-0000-0000-0000-0000000000f1', 'MT-REVIEWED', date '2026-10-28', 700, 'reviewed'),
  ('d6d6d6d6-0000-0000-0000-0000000000f2', 'MT-DRAFT', date '2026-10-29', 550, 'draft');
insert into public.settlement_lines (settlement_id, order_id, tracking_number, outcome, collected_egp, fee_egp) values
  ('d6d6d6d6-0000-0000-0000-0000000000f1', 'd6d6d6d6-0000-0000-0000-0000000000b1', 'MT-00b1', 'delivered', 780, 80),
  ('d6d6d6d6-0000-0000-0000-0000000000f2', 'd6d6d6d6-0000-0000-0000-0000000000b2', 'MT-00b2', 'delivered', 630, 80);
update public.orders set payment_status = 'paid' where id = 'd6d6d6d6-0000-0000-0000-0000000000b1';

select is(
  (select row(received_on, amount_egp)::text from public.v_report_money_in where label = 'MT-REVIEWED'),
  row(date '2026-10-28', 700.00)::text,
  'Accurate''s transfer came in on the day it was received, at what was received');
select is((select count(*)::int from public.v_report_money_in where label = 'MT-DRAFT'), 0,
  'A draft statement is still being checked: not counted yet');
select is((select count(*)::int from public.v_report_money_in where label = 'MT-ACC-1'), 0,
  'An order whose cash was in the transfer is not counted a second time');

-- Sold at the shop for cash, paid there and then.
insert into public.orders (id, order_number, channel, fulfillment_status, payment_status, location_id, payment_method,
                           subtotal_egp, shipping_egp, total_egp, created_at)
values ('d6d6d6d6-0000-0000-0000-0000000000c1', 'MT-SHOP-1', 'store', 'delivered', 'paid',
        'd6d6d6d6-0000-0000-0000-000000000001', 'cash', 550, 0, 550, timestamptz '2026-10-20 12:00+02');
select is(
  (select row(source, received_on, amount_egp)::text from public.v_report_money_in where label = 'MT-SHOP-1'),
  row('shop', date '2026-10-20', 550.00)::text,
  'A shop sale paid at the till came in the day it was rung up');

-- Our driver, cash on delivery: in on the day it was marked paid, with the shipping.
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000c2', 'MT-OWN-1', 'out_for_delivery', 'pending', 'cod', 'MT-JACKET', 700, 0, 50);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000c2', 'own', 'out_for_delivery', 750);
select public.complete_own_delivery('d6d6d6d6-0000-0000-0000-0000000000c2');
select is(
  (select row(source, received_on, amount_egp)::text from public.v_report_money_in where label = 'MT-OWN-1'),
  row('own_driver', (now() at time zone 'Africa/Cairo')::date, 750.00)::text,
  'Our driver''s cash came in the day he handed it in: the goods and the shipping');

-- Paid online before it left, then refused; the price paid back.
select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000c3', 'MT-PREPAID-1', 'delivered', 'paid', 'instapay', 'MT-HOODIE', 550, 0, 80);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000c3', 'accurate', 'delivered', 0);
insert into public.returns (order_id, type, reason, status, value_egp, refund_egp, refunded_at, received_at)
values ('d6d6d6d6-0000-0000-0000-0000000000c3', 'post_delivery', 'wrong_size', 'received', 550, 550, now(), now());
select is(
  (select string_agg(source || ':' || amount_egp, ' ' order by source) from public.v_report_money_in where label = 'MT-PREPAID-1'),
  'paid_before_shipping:630.00 refund:-550.00',
  'Paid before it left is money in; what was paid back is money out');

-- --- What the couriers hold ----------------------------------------------------------------

select is(
  (select row(state, amount_egp)::text from public.v_money_with_couriers where order_number = 'MT-ACC-2'),
  row('collected', 630.00)::text,
  'Delivered and only on a draft statement: Accurate still holds what it collected');
select is((select count(*)::int from public.v_money_with_couriers where order_number = 'MT-ACC-1'), 0,
  'Once on a reviewed statement it was paid over');

select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000d1', 'MT-OUT-1', 'in_transit', 'pending', 'cod', 'MT-JACKET', 700, 0, 80);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000d1', 'accurate', 'in_transit', 780);
select is(
  (select row(state, courier, amount_egp)::text from public.v_money_with_couriers where order_number = 'MT-OUT-1'),
  row('out', 'accurate', 780.00)::text,
  'Still out: what the label asks the customer for');

select pg_temp.order_of('d6d6d6d6-0000-0000-0000-0000000000d2', 'MT-OUT-2', 'out_for_delivery', 'pending', 'cod', 'MT-HOODIE', 550, 0, 50);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000d2', 'own', 'out_for_delivery', 600);
select is(
  (select row(state, courier, amount_egp)::text from public.v_money_with_couriers where order_number = 'MT-OUT-2'),
  row('out', 'own', 600.00)::text,
  'Out with our driver too');

-- Delivered in part: the customer paid for the hoodie and the shipping, not the jacket.
insert into public.orders (id, order_number, channel, fulfillment_status, payment_status, location_id, payment_method,
                           subtotal_egp, shipping_egp, total_egp)
values ('d6d6d6d6-0000-0000-0000-0000000000d3', 'MT-PART-1', 'online', 'in_transit', 'pending',
        'd6d6d6d6-0000-0000-0000-000000000001', 'cod', 1250, 80, 1250);
insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp) values
  ('d6d6d6d6-0000-0000-0000-0000000000d3', 'd6d6d6d6-0000-0000-0000-00000000000a', 'MT-HOODIE', 'Money Test Piece', 1, 550, 550),
  ('d6d6d6d6-0000-0000-0000-0000000000d3', 'd6d6d6d6-0000-0000-0000-00000000000b', 'MT-JACKET', 'Money Test Piece', 1, 700, 700);
select pg_temp.ship('d6d6d6d6-0000-0000-0000-0000000000d3', 'accurate', 'in_transit', 1330);
select public.record_partial_delivery(
  'd6d6d6d6-0000-0000-0000-0000000000d3',
  jsonb_build_array(jsonb_build_object(
    'order_line_item_id', (select id from public.order_line_items where order_id = 'd6d6d6d6-0000-0000-0000-0000000000d3' and sku = 'MT-HOODIE'),
    'quantity_kept', 1)));
select is(
  (select row(state, amount_egp)::text from public.v_money_with_couriers where order_number = 'MT-PART-1'),
  row('collected', 630.00)::text,
  'Delivered in part: Accurate holds the hoodie and the shipping, not the jacket coming back');

select is((select count(*)::int from public.v_money_with_couriers where order_number = 'MT-OWN-1'), 0,
  'Our driver handed his cash in with the delivery: he holds nothing');

select * from finish();
rollback;
