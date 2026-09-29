-- ---------------------------------------------------------------------------
-- Sync issues: unrecognised items closing once imported, settling a whole
-- product at once, and never applying a correction twice.
-- ---------------------------------------------------------------------------

begin;
select plan(17);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('f5f5f5f5-0000-0000-0000-00000000000b', 'sync-stock@test.local',   'authenticated', 'authenticated'),
  ('f5f5f5f5-0000-0000-0000-00000000000d', 'sync-packing@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'stock_manager', is_active = true where id = 'f5f5f5f5-0000-0000-0000-00000000000b';
update public.staff set role = 'packing',       is_active = true where id = 'f5f5f5f5-0000-0000-0000-00000000000d';

insert into public.locations (id, name, type, shopify_location_id, is_active)
values ('f5f5f5f5-0000-0000-0000-000000000001', 'Check Now Shop', 'store', 915001, true);

insert into public.products (id, title)
values ('f5f5f5f5-0000-0000-0000-000000000002', 'Check Now Slipper');

insert into public.variants (id, product_id, sku, price_egp, shopify_inventory_item_id) values
  ('f5f5f5f5-0000-0000-0000-0000000000a1', 'f5f5f5f5-0000-0000-0000-000000000002', 'CHK-40', 900, 915101),
  ('f5f5f5f5-0000-0000-0000-0000000000a2', 'f5f5f5f5-0000-0000-0000-000000000002', 'CHK-41', 900, 915102);

select public.record_stock_movements(
  'f5f5f5f5-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"f5f5f5f5-0000-0000-0000-0000000000a1","quantity_delta":3},
    {"variant_id":"f5f5f5f5-0000-0000-0000-0000000000a2","quantity_delta":2}]'::jsonb
);

-- A product created in Shopify with stock, before anyone imported it: the
-- webhook files its item as unrecognised.
select public.open_sync_issue(
  'unmapped_inventory_item', null, null, null, 4,
  '{"inventory_item_id": 915103, "location_id": 915001}'::jsonb, 'webhook'
);

-- --- Unrecognised until imported -------------------------------------------

select public.close_linked_unmapped_issues();

select is(
  (select status::text from public.sync_issues
    where type = 'unmapped_inventory_item' and details ->> 'inventory_item_id' = '915103'),
  'open',
  'An item no variant claims stays open'
);

-- The import links it.
insert into public.variants (id, product_id, sku, price_egp, shopify_inventory_item_id)
values ('f5f5f5f5-0000-0000-0000-0000000000a3', 'f5f5f5f5-0000-0000-0000-000000000002', 'CHK-42', 900, 915103);

select is(
  (public.reconcile_shopify_inventory(
    '[{"inventory_item_id":915101,"location_id":915001,"available":3},
      {"inventory_item_id":915102,"location_id":915001,"available":7},
      {"inventory_item_id":915103,"location_id":915001,"available":4}]'::jsonb
  ) ->> 'linked_since_last_check')::int >= 1,
  true,
  'The check reports items linked since the last one'
);

select is(
  (select status::text from public.sync_issues
    where type = 'unmapped_inventory_item' and details ->> 'inventory_item_id' = '915103'),
  'resolved',
  'Once imported, the unrecognised item closes'
);

select is(
  (select shopify_quantity from public.sync_issues
    where type = 'quantity_mismatch' and status = 'open'
      and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a3'),
  4,
  'And its Shopify stock shows as a difference to settle'
);

select is(
  (select count(*)::int from public.sync_issues
    where type = 'quantity_mismatch' and status = 'open'
      and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a1'),
  0,
  'A size that agrees raises nothing'
);

-- --- Only stock people settle ----------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f5f5f5f5-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.resolve_sync_issues(
       array(select id from public.sync_issues where status = 'open'
              and variant_id in ('f5f5f5f5-0000-0000-0000-0000000000a2',
                                 'f5f5f5f5-0000-0000-0000-0000000000a3')),
       'trust_shopify') $$,
  '42501', null,
  'A packing user cannot settle sync issues'
);

-- --- A whole product at once -----------------------------------------------

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f5f5f5f5-0000-0000-0000-00000000000b"}';

select is(
  public.resolve_sync_issues(
    array(select id from public.sync_issues where status = 'open' and type = 'quantity_mismatch'
           and variant_id in ('f5f5f5f5-0000-0000-0000-0000000000a2',
                              'f5f5f5f5-0000-0000-0000-0000000000a3')),
    'trust_shopify'),
  2,
  'Both sizes are settled in one go'
);

select is(
  (select array_agg(quantity order by variant_id) from public.stock_levels
    where variant_id in ('f5f5f5f5-0000-0000-0000-0000000000a2',
                         'f5f5f5f5-0000-0000-0000-0000000000a3')),
  array[7, 4],
  'The CRM now holds Shopify''s numbers'
);

-- --- Never twice ------------------------------------------------------------

select is(
  public.resolve_sync_issues(
    array(select id from public.sync_issues where type = 'quantity_mismatch'
           and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2'),
    'trust_shopify'),
  0,
  'Settling them again finds nothing to do'
);

select public.resolve_sync_issue(
  (select id from public.sync_issues where type = 'quantity_mismatch'
    and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2'),
  'trust_shopify'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2'),
  7,
  'A second tap on one issue does not add the correction again'
);

select is(
  (select count(*)::int from public.stock_movements
    where variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2' and reason = 'adjustment'),
  1,
  'Exactly one adjustment was written'
);

-- --- The CRM is right: Shopify is told again --------------------------------

select set_config('request.jwt.claims', '', true);
reset role;

delete from public.sync_outbox where variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a1';

select public.reconcile_shopify_inventory(
  '[{"inventory_item_id":915101,"location_id":915001,"available":9},
    {"inventory_item_id":915102,"location_id":915001,"available":8}]'::jsonb
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f5f5f5f5-0000-0000-0000-00000000000b"}';

select public.resolve_sync_issue(
  (select id from public.sync_issues where status = 'open' and type = 'quantity_mismatch'
    and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a1'),
  'trust_crm'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a1'),
  3,
  'Trusting the CRM leaves stock alone'
);

select set_config('request.jwt.claims', '', true);
reset role;

select is(
  (select count(*)::int from public.sync_outbox
    where variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a1'),
  1,
  'And queues our number to be sent to Shopify again'
);

-- --- All or nothing ---------------------------------------------------------

select public.reconcile_shopify_inventory(
  '[{"inventory_item_id":915199,"location_id":915001,"available":2}]'::jsonb
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f5f5f5f5-0000-0000-0000-00000000000b"}';

select throws_ok(
  $$ select public.resolve_sync_issues(
       array(select id from public.sync_issues where status = 'open'
              and (variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2'
                   or details ->> 'inventory_item_id' = '915199')),
       'trust_shopify') $$,
  '22023', null,
  'A batch containing an issue that cannot take Shopify''s count is refused'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2'),
  7,
  'And nothing in that batch was applied'
);

select is(
  (select status::text from public.sync_issues
    where type = 'quantity_mismatch' and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a2'
      and resolved_at is null),
  'open',
  'The difference in that batch is still open'
);

select set_config('request.jwt.claims', '', true);
reset role;

select public.open_sync_issue(
  'missing_in_shopify', 'f5f5f5f5-0000-0000-0000-0000000000a1',
  'f5f5f5f5-0000-0000-0000-000000000001', 3, null, '{}'::jsonb, 'test'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f5f5f5f5-0000-0000-0000-00000000000b"}';

select throws_ok(
  $$ select public.resolve_sync_issue(
       (select id from public.sync_issues where status = 'open' and type = 'missing_in_shopify'
         and variant_id = 'f5f5f5f5-0000-0000-0000-0000000000a1'),
       'trust_shopify') $$,
  '22023', null,
  'Shopify''s count cannot be accepted when Shopify gave none'
);

select * from finish();
rollback;
