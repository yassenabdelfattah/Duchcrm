-- ---------------------------------------------------------------------------
-- Website orders after they arrive: the CRM decides, Shopify follows.
--
-- What matters: a Shopify "refund" never moves stock (it counted #1406's item
-- twice); a change made in Shopify is followed exactly once, never undone by
-- an older webhook, and never followed once the parcel has left; a change
-- made in the CRM is queued for Shopify, and wins while it waits.
-- ---------------------------------------------------------------------------

begin;
select plan(45);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active, shopify_location_id)
values ('d4d4d4d4-0000-0000-0000-000000000001', 'Sync Test Warehouse', 'warehouse', false, true, 55502);

insert into public.products (id, title)
values ('d4d4d4d4-0000-0000-0000-000000000002', 'Sync Test Tee');

insert into public.variants (id, product_id, sku, size, price_egp, shopify_variant_id)
values
  ('d4d4d4d4-0000-0000-0000-00000000000a', 'd4d4d4d4-0000-0000-0000-000000000002', 'SYNC-A', 'S', 500.00, 88801),
  ('d4d4d4d4-0000-0000-0000-00000000000b', 'd4d4d4d4-0000-0000-0000-000000000002', 'SYNC-B', 'M', 500.00, 88802),
  ('d4d4d4d4-0000-0000-0000-00000000000c', 'd4d4d4d4-0000-0000-0000-000000000002', 'SYNC-C', 'L', 600.00, 88803);

select public.record_stock_movements(
  'd4d4d4d4-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-00000000000a","quantity_delta":10},
    {"variant_id":"d4d4d4d4-0000-0000-0000-00000000000b","quantity_delta":10},
    {"variant_id":"d4d4d4d4-0000-0000-0000-00000000000c","quantity_delta":10}]'::jsonb
);

create or replace function pg_temp.stock(p_sku text)
returns integer
language sql
as $$
  select sl.quantity
    from public.stock_levels sl
    join public.variants v on v.id = sl.variant_id
   where v.sku = p_sku
     and sl.location_id = 'd4d4d4d4-0000-0000-0000-000000000001';
$$;

create or replace function pg_temp.line(p_variant bigint, p_sku text, p_quantity integer, p_current integer, p_price text default '500.00')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_variant * 10, 'variant_id', p_variant, 'sku', p_sku,
    'title', 'Sync Test Tee', 'variant_title', p_sku,
    'quantity', p_quantity, 'current_quantity', p_current,
    'price', p_price, 'total_discount', '0.00'
  );
$$;

create or replace function pg_temp.web_order(p_id bigint, p_updated_at text, p_items jsonb, p_shipping text default '70.00')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id,
    'name', '#' || (p_id % 10000)::text,
    'updated_at', p_updated_at,
    'currency', 'EGP',
    'financial_status', 'pending',
    'total_discounts', '0.00',
    'payment_gateway_names', jsonb_build_array('Cash on Delivery (COD)'),
    'total_shipping_price_set', jsonb_build_object(
      'shop_money', jsonb_build_object('amount', p_shipping, 'currency_code', 'EGP')
    ),
    'shipping_lines', jsonb_build_array(jsonb_build_object('title', 'Delivery', 'price', p_shipping, 'is_removed', false)),
    'customer', jsonb_build_object('id', 900101, 'first_name', 'Salma', 'last_name', 'Adel'),
    'shipping_address', jsonb_build_object('first_name', 'Salma', 'last_name', 'Adel', 'address1', '3 Street', 'city', 'Giza'),
    'line_items', p_items
  );
$$;

-- Order #6001: one A, one B.
select public.ingest_shopify_order(
  pg_temp.web_order(6001, '2026-10-15T10:00:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1),
    pg_temp.line(88802, 'SYNC-B', 1, 1)
  )),
  'd4d4d4d4-0000-0000-0000-000000000001'
);

-- --- A Shopify refund moves no stock -----------------------------------------

select public.apply_shopify_refund(jsonb_build_object(
  'id', 7001, 'order_id', 6001, 'transactions', '[]'::jsonb,
  'refund_line_items', jsonb_build_array(jsonb_build_object(
    'quantity', 1, 'restock_type', 'cancel',
    'line_item', jsonb_build_object('variant_id', 88802, 'sku', 'SYNC-B')
  ))
));

select is(pg_temp.stock('SYNC-B'), 9,
  'A Shopify refund that "restocks" an item moves no stock: the order''s own lines do that');

select is(
  (select payment_status::text from public.orders where shopify_order_id = 6001),
  'pending',
  'A refund with no money in it (an edit to a cash-on-delivery order) leaves the order unpaid');

-- --- Following a change made in Shopify --------------------------------------

-- B taken off, two C added, shipping now 90.
select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6001, '2026-10-15T11:00:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1),
    pg_temp.line(88802, 'SYNC-B', 1, 0),
    pg_temp.line(88803, 'SYNC-C', 2, 2, '600.00')
  ), '90.00')) ->> 'result',
  'updated',
  'An order edited in Shopify before it ships is followed');

select is(
  (select string_agg(li.sku || ' x' || li.quantity, ', ' order by li.sku)
     from public.order_line_items li join public.orders o on o.id = li.order_id
    where o.shopify_order_id = 6001),
  'SYNC-A x1, SYNC-C x2',
  'The CRM order now holds what the Shopify order holds');

select is(pg_temp.stock('SYNC-B'), 10, 'The item taken off came back to stock - once');
select is(pg_temp.stock('SYNC-C'), 8, 'The items added went out of stock');
select is(pg_temp.stock('SYNC-A'), 9, 'The item left alone did not move');

select is(
  (select row(subtotal_egp, total_egp, shipping_egp)::text from public.orders where shopify_order_id = 6001),
  '(1700.00,1700.00,90.00)',
  'Goods, total and shipping follow the edit');

select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6001, '2026-10-15T11:00:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1),
    pg_temp.line(88802, 'SYNC-B', 1, 0),
    pg_temp.line(88803, 'SYNC-C', 2, 2, '600.00')
  ), '90.00')) ->> 'result',
  'stale',
  'The same webhook delivered twice is recognised');

select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6001, '2026-10-15T10:30:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1),
    pg_temp.line(88802, 'SYNC-B', 1, 1)
  ))) ->> 'result',
  'stale',
  'An older update arriving late cannot put back lines a newer one changed');

select is(pg_temp.stock('SYNC-B'), 10, '...and moved no stock');

select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6001, '2026-10-15T12:00:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1),
    pg_temp.line(88802, 'SYNC-B', 1, 0),
    pg_temp.line(88803, 'SYNC-C', 2, 2, '600.00')
  ), '90.00')) ->> 'result',
  'unchanged',
  'An update that changes nothing in the items (a tag, a note, our own edit coming back) changes nothing');

select is(
  (select count(*)::integer from public.stock_movements
    where reference_type = 'shopify_order_edit' and reference_id = '6001'),
  2,
  'Two movements in all: B back, C out');

-- --- A change made in the CRM is queued for Shopify --------------------------

select public.update_order_items(
  (select id from public.orders where shopify_order_id = 6001),
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-00000000000a","quantity":2}]'::jsonb
);

select is(
  (select q.action from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6001),
  'edit',
  'Editing a website order in the CRM queues it for Shopify');

select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6001, '2026-10-15T13:00:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1),
    pg_temp.line(88803, 'SYNC-C', 2, 2, '600.00')
  ), '90.00')) ->> 'result',
  'crm_change_pending',
  'While the CRM''s change is on its way, Shopify''s older version is not followed');

select is(
  (select string_agg(li.sku || ' x' || li.quantity, ', ' order by li.sku)
     from public.order_line_items li join public.orders o on o.id = li.order_id
    where o.shopify_order_id = 6001),
  'SYNC-A x2',
  '...so the CRM keeps its own edit');

create temporary table claimed on commit drop as
select * from public.claim_shopify_order_sync(10, null)
 where order_id = (select id from public.orders where shopify_order_id = 6001);

select is((select count(*)::integer from claimed), 1, 'The job can be claimed');

select is(
  (select count(*)::integer from public.claim_shopify_order_sync(10, (select id from public.orders where shopify_order_id = 6001))),
  0,
  'A claimed job is not handed to a second run at the same time');

select is(
  public.shopify_order_sync_target((select id from public.orders where shopify_order_id = 6001)) -> 'lines',
  '[{"sku": "SYNC-A", "quantity": 2, "variant_id": "d4d4d4d4-0000-0000-0000-00000000000a", "shopify_variant_id": 88801}]'::jsonb,
  'The target is the CRM order''s lines, with Shopify''s variant ids');

select public.complete_shopify_order_sync(
  (select id from public.orders where shopify_order_id = 6001),
  (select requested_at from claimed),
  true, null, '{"changed": true}'::jsonb, '2026-10-15T14:00:00+03:00'
);

select is(
  (select count(*)::integer from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6001),
  0,
  'Done: off the queue');

select is(
  (select count(*)::integer from public.order_events e join public.orders o on o.id = e.order_id
    where o.shopify_order_id = 6001 and e.event_type = 'shopify_synced'),
  1,
  'The order''s history says Shopify was updated');

select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6001, '2026-10-15T13:30:00+03:00', jsonb_build_array(
    pg_temp.line(88801, 'SYNC-A', 1, 1)
  ))) ->> 'result',
  'stale',
  'A webhook from before our edit reached Shopify cannot undo it');

-- A change made while a run is working keeps the order queued for one more.
select public.update_order_items(
  (select id from public.orders where shopify_order_id = 6001),
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-00000000000a","quantity":3}]'::jsonb
);
truncate claimed;
insert into claimed select * from public.claim_shopify_order_sync(10, (select id from public.orders where shopify_order_id = 6001));
select public.update_order_items(
  (select id from public.orders where shopify_order_id = 6001),
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-00000000000a","quantity":4}]'::jsonb
);
select public.complete_shopify_order_sync(
  (select id from public.orders where shopify_order_id = 6001),
  (select requested_at from claimed), true, null, '{}'::jsonb, null
);

select is(
  (select row(q.action, q.claimed_at is null)::text from public.shopify_order_outbox q
     join public.orders o on o.id = q.order_id where o.shopify_order_id = 6001),
  '(edit,t)',
  'An edit made while a run was working stays queued, unclaimed, for the next run');

-- Failing three times puts it in front of a person; succeeding clears that.
truncate claimed;
insert into claimed select * from public.claim_shopify_order_sync(10, (select id from public.orders where shopify_order_id = 6001));
select public.complete_shopify_order_sync((select id from public.orders where shopify_order_id = 6001), (select requested_at from claimed), false, 'ACCESS_DENIED', '{}'::jsonb, null);
select public.complete_shopify_order_sync((select id from public.orders where shopify_order_id = 6001), (select requested_at from claimed), false, 'ACCESS_DENIED', '{}'::jsonb, null);

select is(
  (select count(*)::integer from public.sync_issues
    where type = 'order_sync_failed' and status = 'open' and details ->> 'order_number' = '#6001'),
  0,
  'Two failures are retried quietly');

select public.complete_shopify_order_sync((select id from public.orders where shopify_order_id = 6001), (select requested_at from claimed), false, 'ACCESS_DENIED', '{}'::jsonb, null);

select is(
  (select count(*)::integer from public.sync_issues
    where type = 'order_sync_failed' and status = 'open' and details ->> 'order_number' = '#6001'),
  1,
  'The third shows on Sync issues');

select ok(
  (select q.next_try_at > now() + interval '3 minutes' from public.shopify_order_outbox q
     join public.orders o on o.id = q.order_id where o.shopify_order_id = 6001),
  'Each failure waits longer before the next try');

select public.complete_shopify_order_sync((select id from public.orders where shopify_order_id = 6001), (select requested_at from claimed), true, null, '{}'::jsonb, null);

select is(
  (select status::text from public.sync_issues
    where type = 'order_sync_failed' and details ->> 'order_number' = '#6001'),
  'resolved',
  'Getting through closes that issue by itself');

-- --- Shipping fee, notes, and orders that are not from Shopify ----------------

select public.update_order_details((select id from public.orders where shopify_order_id = 6001), p_note => 'Ring after 5');

select is(
  (select count(*)::integer from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6001),
  0,
  'A note is the CRM''s own business and is not sent to Shopify');

select public.update_order_details((select id from public.orders where shopify_order_id = 6001), p_shipping_egp => 100);

select is(
  (select count(*)::integer from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6001),
  1,
  'A new shipping fee is');

select public.create_store_sale(
  p_location_id     => 'd4d4d4d4-0000-0000-0000-000000000001',
  p_payment_method  => 'cod',
  p_items           => '[{"variant_id":"d4d4d4d4-0000-0000-0000-00000000000a","quantity":1}]'::jsonb,
  p_idempotency_key => 'sync-test-dm-1',
  p_channel         => 'dm'
);

select public.update_order_items(
  (select id from public.orders where idempotency_key = 'sync-test-dm-1'),
  '[{"variant_id":"d4d4d4d4-0000-0000-0000-00000000000a","quantity":2}]'::jsonb
);

select is(
  (select count(*)::integer from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.idempotency_key = 'sync-test-dm-1'),
  0,
  'A DM order has no Shopify copy, so nothing is queued');

-- --- After the parcel has left --------------------------------------------------

select public.ingest_shopify_order(
  pg_temp.web_order(6002, '2026-10-15T10:00:00+03:00', jsonb_build_array(pg_temp.line(88802, 'SYNC-B', 1, 1))),
  'd4d4d4d4-0000-0000-0000-000000000001'
);
update public.orders set fulfillment_status = 'in_transit' where shopify_order_id = 6002;

select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6002, '2026-10-15T11:00:00+03:00', jsonb_build_array(
    pg_temp.line(88802, 'SYNC-B', 1, 0),
    pg_temp.line(88803, 'SYNC-C', 1, 1, '600.00')
  ))) ->> 'result',
  'flagged',
  'An order changed in Shopify after it shipped is flagged, not followed');

select is(pg_temp.stock('SYNC-B'), 9, '...and nothing in the van moves stock');

select is(
  (select details ->> 'shopify_items' from public.sync_issues
    where type = 'order_changed_in_shopify' and details ->> 'order_number' = '#6002'),
  '["SYNC-C x1"]',
  'The issue says what Shopify now has, for a person to decide');

-- A second order's issue is its own row, not merged into the first.
select public.ingest_shopify_order(
  pg_temp.web_order(6003, '2026-10-15T10:00:00+03:00', jsonb_build_array(pg_temp.line(88801, 'SYNC-A', 1, 1))),
  'd4d4d4d4-0000-0000-0000-000000000001'
);
update public.orders set fulfillment_status = 'in_transit' where shopify_order_id = 6003;
select public.sync_shopify_order_lines(pg_temp.web_order(6003, '2026-10-15T11:00:00+03:00', jsonb_build_array(
  pg_temp.line(88801, 'SYNC-A', 1, 2)
)));

select is(
  (select count(*)::integer from public.sync_issues
    where type = 'order_changed_in_shopify' and status = 'open'
      and details ->> 'order_number' in ('#6002', '#6003')),
  2,
  'Two orders changed after shipping are two issues, not one');

-- --- Cancelling ------------------------------------------------------------

select public.ingest_shopify_order(
  pg_temp.web_order(6004, '2026-10-15T10:00:00+03:00', jsonb_build_array(pg_temp.line(88803, 'SYNC-C', 2, 2, '600.00'))),
  'd4d4d4d4-0000-0000-0000-000000000001'
);

-- C is at 10 here: the CRM edit above took #6001's two C off it.
select is(pg_temp.stock('SYNC-C'), 8, 'Setup: #6004 took two C');

select public.cancel_order((select id from public.orders where shopify_order_id = 6004), 'Customer changed their mind');

select is(pg_temp.stock('SYNC-C'), 10, 'Cancelling in the CRM puts the stock back');

select is(
  (select q.action from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6004),
  'cancel',
  '...and queues the cancellation for Shopify');

select public.queue_shopify_order_sync((select id from public.orders where shopify_order_id = 6004), 'edit');

select is(
  (select q.action from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6004),
  'cancel',
  'A cancellation waiting to go out is not turned back into an edit');

-- Cancelled in Shopify, with Shopify's refund for the cancelled items.
select public.ingest_shopify_order(
  pg_temp.web_order(6005, '2026-10-15T10:00:00+03:00', jsonb_build_array(pg_temp.line(88803, 'SYNC-C', 1, 1, '600.00'))),
  'd4d4d4d4-0000-0000-0000-000000000001'
);
select public.cancel_shopify_order(6005, 'customer');
select public.apply_shopify_refund(jsonb_build_object(
  'id', 7005, 'order_id', 6005, 'transactions', '[]'::jsonb,
  'refund_line_items', jsonb_build_array(jsonb_build_object(
    'quantity', 1, 'restock_type', 'cancel',
    'line_item', jsonb_build_object('variant_id', 88803, 'sku', 'SYNC-C')
  ))
));

select is(pg_temp.stock('SYNC-C'), 10,
  'Cancelled in Shopify: the stock comes back once, not once more for Shopify''s refund');

select is(
  (select count(*)::integer from public.shopify_order_outbox q join public.orders o on o.id = q.order_id
    where o.shopify_order_id = 6005),
  0,
  'A cancellation that came from Shopify is not sent back to it');

-- Paid online: the CRM cannot refund, so it does not cancel.
select public.ingest_shopify_order(
  pg_temp.web_order(6006, '2026-10-15T10:00:00+03:00', jsonb_build_array(pg_temp.line(88801, 'SYNC-A', 1, 1))),
  'd4d4d4d4-0000-0000-0000-000000000001'
);
update public.orders set payment_status = 'paid', payment_method = 'card' where shopify_order_id = 6006;

select throws_ok(
  $$ select public.cancel_order((select id from public.orders where shopify_order_id = 6006), null) $$,
  '23514',
  'Order #6006 was paid online. Cancel it in Shopify so the customer is refunded.',
  'An order paid online is cancelled in Shopify, where the customer is refunded'
);

-- --- Money refunded for real ----------------------------------------------------

select public.apply_shopify_refund(jsonb_build_object(
  'id', 7006, 'order_id', 6006,
  'transactions', jsonb_build_array(jsonb_build_object('kind', 'refund', 'status', 'success', 'amount', '200.00')),
  'refund_line_items', '[]'::jsonb
));
select public.apply_shopify_refund(jsonb_build_object(
  'id', 7006, 'order_id', 6006,
  'transactions', jsonb_build_array(jsonb_build_object('kind', 'refund', 'status', 'success', 'amount', '200.00')),
  'refund_line_items', '[]'::jsonb
));

select is(
  (select payment_status::text from public.orders where shopify_order_id = 6006),
  'partially_refunded',
  'Money given back in Shopify marks the order refunded in part');

select is(
  (select count(*)::integer from public.order_events e join public.orders o on o.id = e.order_id
    where o.shopify_order_id = 6006 and e.event_type = 'shopify_refund'),
  1,
  'The same refund delivered twice is counted once');

-- --- Orders from before the CRM ------------------------------------------------

-- Tidying old orders in Shopify sends orders/updated for each. An order placed
-- before go-live is history: its stock was in the opening count (2026-10-22).
select is(
  public.sync_shopify_order_lines(pg_temp.web_order(6999, '2026-10-22T13:00:00+03:00',
    jsonb_build_array(pg_temp.line(88801, 'SYNC-A', 1, 1))) || '{"created_at": "2026-03-10T21:04:33+02:00"}'::jsonb) ->> 'result',
  'before_crm',
  'An order placed in Shopify before go-live is not imported when it is changed there');

select is(
  (select count(*)::integer from public.orders where shopify_order_id = 6999),
  0,
  '...so it takes nothing out of stock');

select * from finish();
rollback;
