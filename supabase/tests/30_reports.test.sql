-- ---------------------------------------------------------------------------
-- Reports count sales the way Shopify does (2026-10-28): gross on the day
-- ordered, less discounts, less what came back on the day it came back, and
-- never a cancelled order.
-- ---------------------------------------------------------------------------

begin;
select plan(7);

insert into public.locations (id, name, type, is_default, is_active)
values ('b0b0b0b0-0000-0000-0000-000000000001', 'Report Test Shop', 'store', false, true);

insert into public.customers (id, full_name, phone, governorate)
values ('b0b0b0b0-0000-0000-0000-0000000000c1', 'Report Customer', '01599955566', 'Giza');

-- Two hoodies at 1,000 with 100 off the order; refused at the door. Then a
-- second order from the same customer; and one cancelled.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id, customer_id,
  payment_method, subtotal_egp, discount_egp, shipping_egp, total_egp, created_at, cancelled_at
) values
  ('b0b0b0b0-0000-0000-0000-0000000000a1', 'REP-1', 'online', 'returned', 'pending',
   'b0b0b0b0-0000-0000-0000-000000000001', 'b0b0b0b0-0000-0000-0000-0000000000c1',
   'cod', 2000, 100, 70, 1900, '2026-10-20 10:00+02', null),
  ('b0b0b0b0-0000-0000-0000-0000000000a2', 'REP-2', 'online', 'delivered', 'paid',
   'b0b0b0b0-0000-0000-0000-000000000001', 'b0b0b0b0-0000-0000-0000-0000000000c1',
   'cod', 500, 0, 70, 500, '2026-10-22 10:00+02', null),
  ('b0b0b0b0-0000-0000-0000-0000000000a3', 'REP-3', 'online', 'cancelled', 'pending',
   'b0b0b0b0-0000-0000-0000-000000000001', 'b0b0b0b0-0000-0000-0000-0000000000c1',
   'cod', 800, 0, 70, 800, '2026-10-21 10:00+02', '2026-10-21 12:00+02');

insert into public.order_line_items (id, order_id, sku, title, quantity, unit_price_egp, total_egp) values
  ('b0b0b0b0-0000-0000-0000-0000000000d1', 'b0b0b0b0-0000-0000-0000-0000000000a1', 'REP-HOOD', 'Report Hoodie', 2, 1000, 2000),
  ('b0b0b0b0-0000-0000-0000-0000000000d2', 'b0b0b0b0-0000-0000-0000-0000000000a2', 'REP-TEE', 'Report Tee', 1, 500, 500),
  ('b0b0b0b0-0000-0000-0000-0000000000d3', 'b0b0b0b0-0000-0000-0000-0000000000a3', 'REP-CAP', 'Report Cap', 1, 800, 800);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at)
values ('b0b0b0b0-0000-0000-0000-0000000000a1', 'REP-SHIP-1', 'outbound', 'returned', 1970, '2026-10-20 18:00+02');

-- Back in the shop just after midnight Cairo on the 25th - still the 24th in UTC.
insert into public.returns (id, order_id, type, reason, status, received_at)
values ('b0b0b0b0-0000-0000-0000-0000000000e1', 'b0b0b0b0-0000-0000-0000-0000000000a1',
        'failed_delivery', 'refused_unopened', 'received', '2026-10-25 00:30+03');
insert into public.return_lines (return_id, order_line_item_id, sku, quantity_expected, quantity_received, quantity_resellable)
values ('b0b0b0b0-0000-0000-0000-0000000000e1', 'b0b0b0b0-0000-0000-0000-0000000000d1', 'REP-HOOD', 2, 2, 2);

-- --- What was sold ---------------------------------------------------------------------

select is(
  (select row(gross_egp, discounts_egp, net_egp, placed_on)::text from public.v_report_lines where order_id = 'b0b0b0b0-0000-0000-0000-0000000000a1'),
  row(2000.00::numeric, 100.00::numeric, 1900.00::numeric, '2026-10-20'::date)::text,
  'A line carries its share of the order discount, on the day it was ordered'
);

select is(
  (select count(*)::int from public.v_report_lines where order_id = 'b0b0b0b0-0000-0000-0000-0000000000a3'),
  0,
  'A cancelled order is never a sale'
);

-- --- What came back --------------------------------------------------------------------

select is(
  (select row(value_egp, quantity, returned_on, return_type)::text from public.v_report_returns
    where order_id = 'b0b0b0b0-0000-0000-0000-0000000000a1'),
  row(1900.00::numeric, 2, '2026-10-25'::date, 'failed_delivery')::text,
  'A refusal comes off at what it sold for, on the Cairo day it came back'
);

-- --- Each order ----------------------------------------------------------------------------

select is(
  (select outcome from public.v_report_orders where order_id = 'b0b0b0b0-0000-0000-0000-0000000000a1'),
  'refused',
  'Refused at the door'
);

select is(
  (select outcome from public.v_report_orders where order_id = 'b0b0b0b0-0000-0000-0000-0000000000a2'),
  'delivered',
  'Delivered'
);

select is(
  (select array_agg(customer_order_no order by placed_on) from public.v_report_orders
    where customer_id = 'b0b0b0b0-0000-0000-0000-0000000000c1'),
  array[1, 2]::bigint[],
  'A customer''s first order and their second, the cancelled one not counted'
);

select is(
  (select row(governorate, units, net_egp)::text from public.v_report_orders where order_id = 'b0b0b0b0-0000-0000-0000-0000000000a1'),
  row('Giza', 2, 1900.00::numeric)::text,
  'Each order knows where it went, how many pieces, and what it came to'
);

select * from finish();
rollback;
