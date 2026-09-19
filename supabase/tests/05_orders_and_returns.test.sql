-- ---------------------------------------------------------------------------
-- The order lifecycle: custody, failed deliveries, and checking returns back in.
--
-- The thing being proven throughout is that stock does not move while goods
-- are in a van, and that a parcel coming back short is visible rather than
-- quietly absorbed.
-- ---------------------------------------------------------------------------

begin;
select plan(23);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('a1a1a1a1-0000-0000-0000-000000000001', 'Order Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('a1a1a1a1-0000-0000-0000-000000000002', 'Test Cargo');

insert into public.variants (id, product_id, sku, size, color, price_egp)
values ('a1a1a1a1-0000-0000-0000-000000000003', 'a1a1a1a1-0000-0000-0000-000000000002',
        'CARGO-OLV-L', 'L', 'Olive', 1800.00);

-- A phone number no other fixture and no seed row uses. customers.phone is
-- uniquely indexed, and these suites run against the seeded database.
insert into public.customers (id, full_name, phone, governorate)
values ('a1a1a1a1-0000-0000-0000-00000000000c', 'Test Customer', '01211100011', 'Cairo');

select public.record_stock_movements(
  'a1a1a1a1-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"a1a1a1a1-0000-0000-0000-000000000003","quantity_delta":10}]'::jsonb
);

-- An online order, as the Shopify webhook will create one: stock is deducted
-- the moment the order exists, because the storefront has already sold it.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp
)
values (
  'a1a1a1a1-0000-0000-0000-0000000000aa',
  public.next_order_number('online'), 'online', 'awaiting_confirmation', 'pending',
  'a1a1a1a1-0000-0000-0000-000000000001', 'a1a1a1a1-0000-0000-0000-00000000000c',
  'cod', 5400.00, 70.00, 5400.00
);

insert into public.order_line_items (
  id, order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp
)
values (
  'a1a1a1a1-0000-0000-0000-0000000000bb',
  'a1a1a1a1-0000-0000-0000-0000000000aa', 'a1a1a1a1-0000-0000-0000-000000000003',
  'CARGO-OLV-L', 'Test Cargo', 3, 1800.00, 5400.00
);

select public.record_stock_movements(
  'a1a1a1a1-0000-0000-0000-000000000001',
  'online_order',
  '[{"variant_id":"a1a1a1a1-0000-0000-0000-000000000003","quantity_delta":-3}]'::jsonb,
  'order', 'a1a1a1a1-0000-0000-0000-0000000000aa'
);

-- --- The lifecycle starts before packing -----------------------------------

select is(
  (select fulfillment_status::text from public.orders
    where id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'awaiting_confirmation',
  'A new online order waits for the confirmation call'
);

select is(
  (select payment_status::text from public.orders
    where id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'pending',
  'And is unpaid, because cash on delivery has not been collected'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa' and event_type = 'created'),
  1,
  'Creating the order logged an event'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'a1a1a1a1-0000-0000-0000-000000000003'),
  7,
  'The storefront already sold it, so stock came off at order creation'
);

-- --- Transitions are recorded, not just applied ----------------------------

update public.orders set fulfillment_status = 'confirmed'
 where id = 'a1a1a1a1-0000-0000-0000-0000000000aa';

select is(
  (select to_fulfillment::text from public.order_events
    where order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa'
      and event_type = 'fulfillment_change'
    order by created_at desc limit 1),
  'confirmed',
  'A status change writes its own history entry'
);

select throws_ok(
  $$ update public.order_events set note = 'tampered'
      where order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa' $$,
  '23001',
  null,
  'Order history cannot be edited after the fact'
);

-- --- Creating the shipment -------------------------------------------------

select is(
  (select (public.record_shipment(
     'a1a1a1a1-0000-0000-0000-0000000000aa', 'ACC-TRACK-0001'
   )).cod_amount_egp),
  5470.00::numeric,
  'The courier is told to collect the goods plus the shipping the customer pays'
);

select is(
  (select fulfillment_status::text from public.orders
    where id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'awaiting_pickup',
  'The order is waiting for the pickup car'
);

-- --- Custody begins at handover --------------------------------------------

select is_empty(
  $$ select shipment_id from public.v_courier_custody $$,
  'Nothing is in courier custody until it is physically handed over'
);

select public.mark_shipment_handed_over(
  (select id from public.shipments where tracking_number = 'ACC-TRACK-0001')
);

select is(
  (select units_out from public.v_courier_custody
    where tracking_number = 'ACC-TRACK-0001'),
  3::bigint,
  'Three pieces are now outside the building and accounted for'
);

select is(
  (select fulfillment_status::text from public.orders
    where id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'in_transit',
  'The order is with the courier'
);

-- --- A parcel with the courier cannot just be cancelled --------------------

select throws_ok(
  $$ select public.cancel_order('a1a1a1a1-0000-0000-0000-0000000000aa', 'changed mind') $$,
  '23514',
  null,
  'An order already with the courier must come back through returns, not be cancelled'
);

-- --- The customer refuses it -----------------------------------------------

select lives_ok(
  $$ select public.record_delivery_failure(
       'a1a1a1a1-0000-0000-0000-0000000000aa',
       'refused_after_inspection',
       'Opened it at the door and did not want it'
     ) $$,
  'A refusal at the door is recorded'
);

select is(
  (select quantity_expected from public.return_lines rl
     join public.returns r on r.id = rl.return_id
    where r.order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  3,
  'All three pieces are expected back'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'a1a1a1a1-0000-0000-0000-000000000003'),
  7,
  'The refusal moved no stock - the goods are still in a van'
);

select is(
  (select fulfillment_status::text from public.orders
    where id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'return_in_transit',
  'The order stays open while the parcel is on its way back'
);

-- --- It comes back short ---------------------------------------------------
--
-- Three went out. Two come back: one sellable, one damaged. The third is
-- missing, which is exactly the case the whole custody design exists for.

select public.receive_return(
  (select id from public.returns where order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  jsonb_build_array(jsonb_build_object(
    'return_line_id', (
      select rl.id from public.return_lines rl
        join public.returns r on r.id = rl.return_id
       where r.order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa'
    ),
    'quantity_resellable', 1,
    'quantity_damaged', 1,
    'condition_note', 'One with a mark on the knee'
  )),
  'Checked in from the daily return run'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'a1a1a1a1-0000-0000-0000-000000000003'),
  8,
  'Only the sellable piece went back into stock'
);

select is(
  (select quantity_missing from public.return_lines rl
     join public.returns r on r.id = rl.return_id
    where r.order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  1,
  'The piece that never arrived is counted as missing'
);

select is(
  (select status::text from public.returns
    where order_id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'discrepancy',
  'A return that arrived short does not quietly close'
);

select isnt_empty(
  $$ select return_id from public.v_return_discrepancies $$,
  'And it appears on the discrepancy report for someone to chase'
);

select is(
  (select fulfillment_status::text from public.orders
    where id = 'a1a1a1a1-0000-0000-0000-0000000000aa'),
  'returned',
  'The order closes once the goods are physically accounted for'
);

select is_empty(
  $$ select shipment_id from public.v_courier_custody $$,
  'And nothing is left in courier custody'
);

-- --- A store sale can still be voided at the counter -----------------------
--
-- Store sales are created already delivered, so the courier guard above must
-- not catch them.

select lives_ok(
  $$ select public.cancel_order(
       (select id from public.create_store_sale(
          'a1a1a1a1-0000-0000-0000-000000000001', 'cash',
          '[{"variant_id":"a1a1a1a1-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
          'void-test-key-0001'
        )),
       'Customer changed their mind at the till'
     ) $$,
  'A store sale can be voided even though it was created as delivered'
);

select * from finish();
rollback;
