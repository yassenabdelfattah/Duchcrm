-- ---------------------------------------------------------------------------
-- Sync: telling our own echo apart from real news, and reporting rather than
-- silently correcting anything we cannot explain.
-- ---------------------------------------------------------------------------

begin;
select plan(14);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, shopify_location_id, is_active)
values ('dddddddd-0000-0000-0000-000000000001', 'Sync Shop', 'store', 777001, true);

insert into public.products (id, title)
values ('dddddddd-0000-0000-0000-000000000002', 'Sync Hoodie');

insert into public.variants (id, product_id, sku, price_egp, shopify_inventory_item_id)
values
  ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000002', 'SYNC-HOOD-M', 1200.00, 888001),
  ('dddddddd-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-000000000002', 'SYNC-HOOD-L', 1200.00, 888002);

select public.record_stock_movements(
  'dddddddd-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"dddddddd-0000-0000-0000-000000000003","quantity_delta":8},
    {"variant_id":"dddddddd-0000-0000-0000-000000000004","quantity_delta":4}]'::jsonb
);

-- --- Every movement asks to be pushed --------------------------------------

select is(
  (select count(*)::int from public.sync_outbox
    where location_id = 'dddddddd-0000-0000-0000-000000000001'),
  2,
  'Receiving stock marks both variants as needing a push to Shopify'
);

-- --- A push, start to finish -----------------------------------------------

select is(
  (select (public.begin_inventory_push(
     'dddddddd-0000-0000-0000-000000000003',
     'dddddddd-0000-0000-0000-000000000001'
   )).quantity),
  8,
  'A push carries the current CRM quantity'
);

select public.complete_inventory_push(
  (select id from public.shopify_inventory_pushes
    where variant_id = 'dddddddd-0000-0000-0000-000000000003'
    order by created_at desc limit 1),
  'succeeded'
);

select is(
  (select shopify_pushed_quantity from public.stock_levels
    where variant_id = 'dddddddd-0000-0000-0000-000000000003'),
  8,
  'A successful push records what we told Shopify'
);

-- --- The echo --------------------------------------------------------------
--
-- Shopify now fires inventory_levels/update back at us carrying the number we
-- just sent. Recognising this is what stops the sync loop.

select is(
  public.classify_inventory_webhook(888001, 777001, 8) ->> 'classification',
  'echo',
  'An inventory webhook repeating our own push is recognised as an echo'
);

-- --- Agreement -------------------------------------------------------------
--
-- The common case for an online order: Shopify decremented its own count when
-- the order was placed, and our orders/create handler already recorded it.

select is(
  public.classify_inventory_webhook(888002, 777001, 4) ->> 'classification',
  'in_agreement',
  'A webhook that matches the CRM needs no action'
);

-- --- A genuine difference --------------------------------------------------

select is(
  public.classify_inventory_webhook(888002, 777001, 99) ->> 'classification',
  'divergent',
  'A quantity we cannot account for is flagged as divergent'
);

select is(
  (public.classify_inventory_webhook(888002, 777001, 99) ->> 'difference')::int,
  95,
  'The size of the difference is reported'
);

-- --- Classifying never writes to the ledger --------------------------------

select is(
  (select quantity from public.stock_levels
    where variant_id = 'dddddddd-0000-0000-0000-000000000004'),
  4,
  'Classifying a divergent webhook changed no stock'
);

-- --- Unknown items ---------------------------------------------------------

select is(
  public.classify_inventory_webhook(999999, 777001, 3) ->> 'classification',
  'unmapped',
  'A webhook for an inventory item we do not know about is unmapped'
);

-- --- Issues are not duplicated ---------------------------------------------

select public.open_sync_issue(
  'quantity_mismatch', 'dddddddd-0000-0000-0000-000000000004',
  'dddddddd-0000-0000-0000-000000000001', 4, 99, '{}'::jsonb, 'test'
);
select public.open_sync_issue(
  'quantity_mismatch', 'dddddddd-0000-0000-0000-000000000004',
  'dddddddd-0000-0000-0000-000000000001', 4, 99, '{}'::jsonb, 'test'
);

select is(
  (select count(*)::int from public.sync_issues
    where type = 'quantity_mismatch'
      and variant_id = 'dddddddd-0000-0000-0000-000000000004'),
  1,
  'The same ongoing problem is one issue, not one per detection'
);

select is(
  (select occurrences from public.sync_issues
    where type = 'quantity_mismatch'
      and variant_id = 'dddddddd-0000-0000-0000-000000000004'),
  2,
  'But the repeat is counted'
);

-- --- Nightly reconciliation ------------------------------------------------

select public.reconcile_shopify_inventory(
  '[{"inventory_item_id":888001,"location_id":777001,"available":8},
    {"inventory_item_id":888002,"location_id":777001,"available":4}]'::jsonb
);

select is(
  (select status::text from public.sync_issues
    where type = 'quantity_mismatch'
      and variant_id = 'dddddddd-0000-0000-0000-000000000004'),
  'resolved',
  'Agreement at reconciliation closes the open mismatch'
);

select public.reconcile_shopify_inventory(
  '[{"inventory_item_id":888001,"location_id":777001,"available":8},
    {"inventory_item_id":888002,"location_id":777001,"available":1}]'::jsonb
);

select is(
  (select shopify_quantity from public.sync_issues
    where type = 'quantity_mismatch'
      and variant_id = 'dddddddd-0000-0000-0000-000000000004'
      and status = 'open'),
  1,
  'A real disagreement opens an issue rather than being corrected silently'
);

-- --- Accepting Shopify's count is an entry in the ledger, not an edit ------

select public.resolve_sync_issue(
  (select id from public.sync_issues
    where type = 'quantity_mismatch'
      and variant_id = 'dddddddd-0000-0000-0000-000000000004'
      and status = 'open'),
  'trust_shopify',
  'Counted the rail by hand; Shopify was right'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'dddddddd-0000-0000-0000-000000000004'),
  1,
  'Accepting the Shopify count appends an adjustment rather than editing history'
);

select * from finish();
rollback;
