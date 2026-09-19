-- ---------------------------------------------------------------------------
-- The morning queue: calling the customer, packing, and handing over.
--
-- The point of ringing before dispatch is that a cancellation here costs
-- nothing, while the same cancellation at the door costs a run out, a run back
-- and a full shipping fee. These tests check that path actually works.
-- ---------------------------------------------------------------------------

begin;
select plan(18);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('d4d4d4d4-0000-0000-0000-000000000001', 'Queue Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('d4d4d4d4-0000-0000-0000-000000000002', 'Queue Test Tee');

insert into public.variants (id, product_id, sku, price_egp)
values ('d4d4d4d4-0000-0000-0000-000000000003',
        'd4d4d4d4-0000-0000-0000-000000000002', 'QUEUE-TEE', 800.00);

insert into public.customers (id, full_name, phone, governorate)
values ('d4d4d4d4-0000-0000-0000-00000000000c', 'Queue Customer', '01277700099', 'Giza');

select public.record_stock_movements(
  'd4d4d4d4-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-000000000003","quantity_delta":10}]'::jsonb
);

-- Two online orders waiting to be called, as the Shopify webhook leaves them.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp
)
values
  ('d4d4d4d4-0000-0000-0000-0000000000a1', public.next_order_number('online'), 'online',
   'awaiting_confirmation', 'pending', 'd4d4d4d4-0000-0000-0000-000000000001',
   'd4d4d4d4-0000-0000-0000-00000000000c', 'cod', 800, 70, 800),
  ('d4d4d4d4-0000-0000-0000-0000000000a2', public.next_order_number('online'), 'online',
   'awaiting_confirmation', 'pending', 'd4d4d4d4-0000-0000-0000-000000000001',
   'd4d4d4d4-0000-0000-0000-00000000000c', 'cod', 800, 70, 800);

insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
values
  ('d4d4d4d4-0000-0000-0000-0000000000a1', 'd4d4d4d4-0000-0000-0000-000000000003',
   'QUEUE-TEE', 'Queue Test Tee', 1, 800, 800),
  ('d4d4d4d4-0000-0000-0000-0000000000a2', 'd4d4d4d4-0000-0000-0000-000000000003',
   'QUEUE-TEE', 'Queue Test Tee', 1, 800, 800);

select public.record_stock_movements(
  'd4d4d4d4-0000-0000-0000-000000000001',
  'online_order',
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-000000000003","quantity_delta":-2}]'::jsonb
);

-- --- Both start in the queue, waiting for a call ---------------------------

select is(
  (select count(*)::int from public.v_packing_queue
    where fulfillment_status = 'awaiting_confirmation'
      and order_id in ('d4d4d4d4-0000-0000-0000-0000000000a1',
                       'd4d4d4d4-0000-0000-0000-0000000000a2')),
  2,
  'Both new orders are waiting to be called'
);

select is(
  (select unit_count from public.v_packing_queue
    where order_id = 'd4d4d4d4-0000-0000-0000-0000000000a1'),
  1::bigint,
  'The queue shows how many pieces are in the parcel'
);

select is(
  (select cod_amount_egp from public.v_packing_queue
    where order_id = 'd4d4d4d4-0000-0000-0000-0000000000a1'),
  null,
  'With no shipment yet there is no courier amount - that is what the pack step creates'
);

-- --- Nobody answers --------------------------------------------------------

select public.record_confirmation_call(
  'd4d4d4d4-0000-0000-0000-0000000000a1', 'unreachable', 'Rang twice, no answer'
);

select is(
  (select fulfillment_status::text from public.orders
    where id = 'd4d4d4d4-0000-0000-0000-0000000000a1'),
  'awaiting_confirmation',
  'An unanswered call leaves the order where it is'
);

select is(
  (select confirmation_attempts from public.orders
    where id = 'd4d4d4d4-0000-0000-0000-0000000000a1'),
  1,
  'But the attempt is counted, so a persistent non-answerer becomes visible'
);

select is(
  (select count(*)::int from public.order_events
    where order_id = 'd4d4d4d4-0000-0000-0000-0000000000a1'
      and event_type = 'confirmation_call'),
  1,
  'And the call itself is on the order history'
);

-- --- They answer and confirm -----------------------------------------------

select is(
  (select (public.record_confirmation_call(
     'd4d4d4d4-0000-0000-0000-0000000000a1', 'confirmed', 'Confirmed, wants it Thursday'
   )).fulfillment_status::text),
  'ready_to_pack',
  'Confirming moves the order into the packing queue'
);

select isnt(
  (select confirmed_at from public.orders where id = 'd4d4d4d4-0000-0000-0000-0000000000a1'),
  null,
  'And records when it was confirmed'
);

-- --- The other one cancels on the phone ------------------------------------
--
-- This is the whole reason for ringing first. Cancelling here costs nothing;
-- the same cancellation at the door costs a run out, a run back, and a fee.

select public.record_confirmation_call(
  'd4d4d4d4-0000-0000-0000-0000000000a2', 'cancelled_by_customer', 'Changed their mind'
);

select is(
  (select fulfillment_status::text from public.orders
    where id = 'd4d4d4d4-0000-0000-0000-0000000000a2'),
  'cancelled',
  'A cancellation on the call cancels the order'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'd4d4d4d4-0000-0000-0000-000000000003'),
  9,
  'And the stock goes straight back, because it never left the building'
);

-- --- Asked to receive it later ---------------------------------------------

insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp
)
values (
  'd4d4d4d4-0000-0000-0000-0000000000a3', public.next_order_number('online'), 'online',
  'awaiting_confirmation', 'pending', 'd4d4d4d4-0000-0000-0000-000000000001',
  'cod', 800, 70, 800
);

select public.record_confirmation_call(
  'd4d4d4d4-0000-0000-0000-0000000000a3', 'asked_to_delay', 'Travelling until next week',
  (current_date + 7)
);

select is_empty(
  $$ select order_id from public.v_packing_queue
      where order_id = 'd4d4d4d4-0000-0000-0000-0000000000a3' $$,
  'An order held for later drops out of the queue rather than looking neglected'
);

-- --- Packing ---------------------------------------------------------------

select throws_ok(
  $$ select public.mark_order_packed('d4d4d4d4-0000-0000-0000-0000000000a3') $$,
  '23514',
  null,
  'An order that has not been confirmed cannot be packed'
);

select is(
  (select (public.mark_order_packed('d4d4d4d4-0000-0000-0000-0000000000a1')).fulfillment_status::text),
  'packed',
  'A confirmed order can be packed'
);

select is(
  (select (public.unpack_order('d4d4d4d4-0000-0000-0000-0000000000a1', 'Wrong size in the box')).fulfillment_status::text),
  'ready_to_pack',
  'And a mistake can be put back without an admin editing the table by hand'
);

select public.mark_order_packed('d4d4d4d4-0000-0000-0000-0000000000a1');

-- --- Handing it to the courier ---------------------------------------------

select is(
  (select (public.record_shipment(
     'd4d4d4d4-0000-0000-0000-0000000000a1', 'ACC-QUEUE-0001'
   )).cod_amount_egp),
  870.00::numeric,
  'The courier is told to collect the goods plus the shipping'
);

select is(
  (select tracking_number from public.v_packing_queue
    where order_id = 'd4d4d4d4-0000-0000-0000-0000000000a1'),
  'ACC-QUEUE-0001',
  'The queue now shows the courier code, ready for the pickup car'
);

select is(
  (select (public.mark_shipment_handed_over(
     (select id from public.shipments where tracking_number = 'ACC-QUEUE-0001')
   )).status::text),
  'in_transit',
  'Handing it over starts the custody clock'
);

select is_empty(
  $$ select order_id from public.v_packing_queue
      where order_id = 'd4d4d4d4-0000-0000-0000-0000000000a1' $$,
  'And the order leaves the queue, because nothing in the office is waiting on it'
);

select * from finish();
rollback;
