-- ---------------------------------------------------------------------------
-- The stock ledger: append-only, self-consistent, and safe to retry.
-- ---------------------------------------------------------------------------

begin;
select plan(18);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_active)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Test Warehouse', 'warehouse', true);

insert into public.products (id, title)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'Test Tee');

insert into public.variants (id, product_id, sku, price_egp)
values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'TEST-TEE-M', 500.00),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000002', 'TEST-TEE-L', 500.00);

-- --- A variant that has never moved has no stock ---------------------------

select is(
  public.stock_ledger_balance(
    'aaaaaaaa-0000-0000-0000-000000000003',
    'aaaaaaaa-0000-0000-0000-000000000001'
  ),
  0,
  'A variant with no movements has a ledger balance of zero'
);

-- --- Receiving stock -------------------------------------------------------

select lives_ok(
  $$ select public.record_stock_movements(
       'aaaaaaaa-0000-0000-0000-000000000001',
       'production_in',
       '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity_delta":10}]'::jsonb
     ) $$,
  'Production can be received into the ledger'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  10,
  'The running total reflects the received stock'
);

select is(
  public.stock_ledger_balance(
    'aaaaaaaa-0000-0000-0000-000000000003',
    'aaaaaaaa-0000-0000-0000-000000000001'
  ),
  10,
  'The ledger and the running total agree'
);

-- --- The cache never disagrees with the ledger -----------------------------

select is_empty(
  $$ select * from public.verify_stock_levels() $$,
  'verify_stock_levels() finds no drift after a movement'
);

-- --- Append-only -----------------------------------------------------------

select throws_ok(
  $$ update public.stock_movements set quantity_delta = 999
      where variant_id = 'aaaaaaaa-0000-0000-0000-000000000003' $$,
  '23001',
  null,
  'A stock movement cannot be updated'
);

select throws_ok(
  $$ delete from public.stock_movements
      where variant_id = 'aaaaaaaa-0000-0000-0000-000000000003' $$,
  '23001',
  null,
  'A stock movement cannot be deleted'
);

select throws_ok(
  $$ insert into public.stock_movements (variant_id, location_id, quantity_delta, reason)
     values ('aaaaaaaa-0000-0000-0000-000000000003',
             'aaaaaaaa-0000-0000-0000-000000000001', 0, 'adjustment') $$,
  '23514',
  null,
  'A movement of zero is rejected - it records nothing'
);

-- --- Overselling is refused ------------------------------------------------

select throws_ok(
  $$ select public.record_stock_movements(
       'aaaaaaaa-0000-0000-0000-000000000001',
       'store_sale',
       '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity_delta":-11}]'::jsonb
     ) $$,
  '23514',
  null,
  'A store sale larger than the stock on hand is refused'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  10,
  'The refused sale left the running total untouched'
);

select is(
  public.stock_ledger_balance(
    'aaaaaaaa-0000-0000-0000-000000000003',
    'aaaaaaaa-0000-0000-0000-000000000001'
  ),
  10,
  'The refused sale left no movement behind either'
);

-- --- Selling exactly what is left is allowed -------------------------------

select lives_ok(
  $$ select public.record_stock_movements(
       'aaaaaaaa-0000-0000-0000-000000000001',
       'store_sale',
       '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity_delta":-10}]'::jsonb
     ) $$,
  'Selling the last unit is allowed'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  0,
  'Stock is now zero'
);

-- --- Recording reasons may go negative -------------------------------------
--
-- An online order that has already been placed on the storefront is a fact.
-- Refusing to record it would make the ledger less accurate, not more.

select lives_ok(
  $$ select public.record_stock_movements(
       'aaaaaaaa-0000-0000-0000-000000000001',
       'online_order',
       '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity_delta":-2}]'::jsonb
     ) $$,
  'An online order is recorded even when it drives stock negative'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  -2,
  'The negative is visible rather than hidden'
);

-- --- A batch is all or nothing --------------------------------------------

select throws_ok(
  $$ select public.record_stock_movements(
       'aaaaaaaa-0000-0000-0000-000000000001',
       'store_sale',
       '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity_delta":-1},
         {"variant_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity_delta":-1}]'::jsonb
     ) $$,
  '23514',
  null,
  'A batch containing one impossible line is rejected whole'
);

select is(
  coalesce((select quantity from public.stock_levels
    where variant_id = 'aaaaaaaa-0000-0000-0000-000000000004'), 0),
  0,
  'The sellable line in the rejected batch was rolled back too'
);

-- --- Retrying with the same key does not move stock twice ------------------

select public.record_stock_movements(
  'aaaaaaaa-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity_delta":5}]'::jsonb,
  'delivery', 'DN-001', null, 'test-idem-key-0001'
);

select public.record_stock_movements(
  'aaaaaaaa-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity_delta":5}]'::jsonb,
  'delivery', 'DN-001', null, 'test-idem-key-0001'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'aaaaaaaa-0000-0000-0000-000000000004'),
  5,
  'Replaying a movement batch with the same idempotency key applies it once'
);

select * from finish();
rollback;
