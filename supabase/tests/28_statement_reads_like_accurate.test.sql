-- ---------------------------------------------------------------------------
-- A statement line reads like Accurate's (2026-10-27): what they collected at
-- the door, what they charge to carry it, and the net between them - filled
-- in from the order, so only a fee they charged differently is typed.
-- ---------------------------------------------------------------------------

begin;
select plan(11);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_active)
values ('a8a8a8a8-0000-0000-0000-000000000001', 'Accurate Test Shop', 'store', true);

-- N210994 on CSHP--029988: 500 of slippers and 90 shipping, collected 590 -
-- and Accurate charged 95. A parcel paid online, charged 80. One refused.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status,
  location_id, payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('a8a8a8a8-0000-0000-0000-0000000000a1', 'ACCURATE-1', 'online', 'delivered', 'pending',
   'a8a8a8a8-0000-0000-0000-000000000001', 'cod', 500, 90, 500),
  ('a8a8a8a8-0000-0000-0000-0000000000a2', 'ACCURATE-2', 'online', 'delivered', 'paid',
   'a8a8a8a8-0000-0000-0000-000000000001', 'instapay', 1240, 80, 1240),
  ('a8a8a8a8-0000-0000-0000-0000000000a3', 'ACCURATE-3', 'online', 'returned', 'pending',
   'a8a8a8a8-0000-0000-0000-000000000001', 'cod', 700, 110, 700);

insert into public.order_line_items (order_id, sku, title, quantity, unit_price_egp, total_egp) values
  ('a8a8a8a8-0000-0000-0000-0000000000a1', 'TWO-S-40', 'Two-Strap Slipper', 1, 500, 500),
  ('a8a8a8a8-0000-0000-0000-0000000000a2', 'H-L-LTH', 'Leather Hoodie', 1, 1240, 1240),
  ('a8a8a8a8-0000-0000-0000-0000000000a3', 'SLP-45', 'Slipper', 1, 700, 700);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at) values
  ('a8a8a8a8-0000-0000-0000-0000000000a1', 'ACC-READ-1', 'outbound', 'delivered', 590, now() - interval '5 days'),
  ('a8a8a8a8-0000-0000-0000-0000000000a2', 'ACC-READ-2', 'outbound', 'delivered', 0, now() - interval '5 days'),
  ('a8a8a8a8-0000-0000-0000-0000000000a3', 'ACC-READ-3', 'outbound', 'returned', 810, now() - interval '5 days');

insert into public.courier_settlements (id, reference, statement_date, received_at)
values ('a8a8a8a8-0000-0000-0000-0000000000f1', 'ACC-READ-STMT', current_date, current_date);

-- --- Before it goes on ------------------------------------------------------------

select is(
  (select row(p ->> 'expected_egp', p ->> 'fee_egp', p ->> 'door_shipping_egp')::text
     from public.lookup_shipment_for_settlement('ACC-READ-1') p),
  row('590.00', '90.00', '90.00')::text,
  'Choosing a parcel shows what their statement should say for it'
);

-- --- A delivery --------------------------------------------------------------------

select is(
  (select row(collected_egp, fee_egp, net_egp, customer_shipping_egp)::text
     from public.add_settlement_line('a8a8a8a8-0000-0000-0000-0000000000f1', 'ACC-READ-1', 'delivered')),
  row(590.00::numeric(12, 2), 90.00::numeric(12, 2), 500.00::numeric(12, 2), 90.00::numeric(12, 2))::text,
  'Filled in as their columns: collected at the door, the shipping charged, the goods left'
);

select public.update_settlement_line(
  (select id from public.settlement_lines where tracking_number = 'ACC-READ-1'),
  p_fee_egp => 95
);

select is(
  (select row(net_egp, shipping_gain_egp)::text from public.v_settlement_statement
    where tracking_number = 'ACC-READ-1'),
  row(495.00::numeric(12, 2), -5.00::numeric(12, 2))::text,
  'They charged 95 for shipping the customer paid 90 for: 495 in, and the 5 lost is kept'
);

-- --- Paid online --------------------------------------------------------------------

select is(
  (select row(collected_egp, fee_egp, customer_shipping_egp)::text
     from public.add_settlement_line('a8a8a8a8-0000-0000-0000-0000000000f1', 'ACC-READ-2', 'delivered')),
  row(0.00::numeric(12, 2), 80.00::numeric(12, 2), 0.00::numeric(12, 2))::text,
  'Paid online: nothing collected at the door, the shipping charged'
);

select is(
  (select shipping_gain_egp from public.v_settlement_statement where tracking_number = 'ACC-READ-2'),
  null,
  'Its shipping was paid to us, not at the door, so there is no gain or loss to show on it'
);

-- --- A return -------------------------------------------------------------------------

select is(
  (select row(collected_egp, fee_egp)::text
     from public.add_settlement_line('a8a8a8a8-0000-0000-0000-0000000000f1', 'ACC-READ-3', 'returned_refused', null, 15)),
  row(0.00::numeric(12, 2), 15.00::numeric(12, 2))::text,
  'A return collected nothing; its fee is what their paper says'
);

-- --- The totals ---------------------------------------------------------------------------

select is(
  (select row(collected_egp, fees_egp, net_egp)::text from public.v_settlement_breakdown
    where settlement_id = 'a8a8a8a8-0000-0000-0000-0000000000f1'),
  row(590.00::numeric, 190.00::numeric, 400.00::numeric)::text,
  'The statement''s totals are theirs, column for column'
);

select is(
  (select row(goods_egp, customer_shipping_egp, collection_difference_egp)::text from public.v_settlement_breakdown
    where settlement_id = 'a8a8a8a8-0000-0000-0000-0000000000f1'),
  row(500.00::numeric, 90.00::numeric, 0.00::numeric)::text,
  'The shipping in what was collected is not mistaken for a collection difference'
);

-- --- Switching -----------------------------------------------------------------------------

select public.update_settlement_line(
  (select id from public.settlement_lines where tracking_number = 'ACC-READ-1'),
  'returned_other'
);

select is(
  (select collected_egp from public.settlement_lines where tracking_number = 'ACC-READ-1'),
  0.00::numeric(12, 2),
  'Turned into a return, it collected nothing'
);

select public.update_settlement_line(
  (select id from public.settlement_lines where tracking_number = 'ACC-READ-1'),
  'delivered'
);

select is(
  (select collected_egp from public.settlement_lines where tracking_number = 'ACC-READ-1'),
  590.00::numeric(12, 2),
  'And back to a delivery, the goods and the shipping again'
);

-- --- A line entered before -------------------------------------------------------------------

-- Collected the goods alone, nothing charged, no customer shipping recorded.
insert into public.courier_settlements (id, reference, statement_date, received_at)
values ('a8a8a8a8-0000-0000-0000-0000000000f2', 'ACC-READ-OLD', current_date, current_date);
insert into public.settlement_lines (settlement_id, order_id, tracking_number, outcome, collected_egp, fee_egp)
values ('a8a8a8a8-0000-0000-0000-0000000000f2', 'a8a8a8a8-0000-0000-0000-0000000000a1', 'ACC-READ-1', 'delivered', 500, 0);

select is(
  (select row(collection_difference_egp, customer_shipping_egp)::text from public.v_settlement_breakdown
    where settlement_id = 'a8a8a8a8-0000-0000-0000-0000000000f2'),
  row(0.00::numeric, 0::numeric)::text,
  'A statement entered the old way adds up as it always did'
);

select * from finish();
rollback;
