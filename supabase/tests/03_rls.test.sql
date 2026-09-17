-- ---------------------------------------------------------------------------
-- Roles are enforced by the database, not by which buttons we render.
--
-- Every test here acts as a real signed-in user (set local role authenticated
-- plus a JWT subject) rather than as the superuser, because a superuser
-- bypasses Row Level Security entirely and would make all of this pass
-- regardless of whether the policies work.
-- ---------------------------------------------------------------------------

begin;
select plan(13);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('cccccccc-0000-0000-0000-00000000000a', 'rls-admin@test.local',   'authenticated', 'authenticated'),
  ('cccccccc-0000-0000-0000-00000000000b', 'rls-stock@test.local',   'authenticated', 'authenticated'),
  ('cccccccc-0000-0000-0000-00000000000c', 'rls-sales@test.local',   'authenticated', 'authenticated'),
  ('cccccccc-0000-0000-0000-00000000000d', 'rls-packing@test.local', 'authenticated', 'authenticated'),
  ('cccccccc-0000-0000-0000-00000000000e', 'rls-pending@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'admin',         is_active = true  where id = 'cccccccc-0000-0000-0000-00000000000a';
update public.staff set role = 'stock_manager', is_active = true  where id = 'cccccccc-0000-0000-0000-00000000000b';
update public.staff set role = 'sales',         is_active = true  where id = 'cccccccc-0000-0000-0000-00000000000c';
update public.staff set role = 'packing',       is_active = true  where id = 'cccccccc-0000-0000-0000-00000000000d';
-- Left exactly as the signup trigger created it: inactive, awaiting approval.

insert into public.locations (id, name, type, is_active)
values ('cccccccc-0000-0000-0000-000000000001', 'RLS Shop', 'store', true);

insert into public.products (id, title)
values ('cccccccc-0000-0000-0000-000000000002', 'RLS Cap');

insert into public.variants (id, product_id, sku, price_egp)
values ('cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000002', 'RLS-CAP', 300.00);

insert into public.variant_costs (variant_id, cost_egp)
values ('cccccccc-0000-0000-0000-000000000003', 110.00);

select public.record_stock_movements(
  'cccccccc-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"cccccccc-0000-0000-0000-000000000003","quantity_delta":10}]'::jsonb
);

-- --- A brand new signup can see nothing ------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-00000000000e"}';

select is_empty(
  $$ select id from public.products $$,
  'A signed-up but not yet approved account sees no products'
);

select is_empty(
  $$ select variant_id from public.stock_levels $$,
  'An unapproved account sees no stock'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- Cost is invisible to sales staff --------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-00000000000c"}';

select isnt_empty(
  $$ select id from public.variants $$,
  'A sales user can read the catalogue'
);

select is_empty(
  $$ select cost_egp from public.variant_costs $$,
  'A sales user cannot read unit costs'
);

select is_empty(
  $$ select id from public.sync_issues $$,
  'A sales user cannot read sync issues'
);

-- --- Sales staff cannot touch the ledger directly --------------------------

select throws_ok(
  $$ insert into public.stock_movements (variant_id, location_id, quantity_delta, reason)
     values ('cccccccc-0000-0000-0000-000000000003',
             'cccccccc-0000-0000-0000-000000000001', 100, 'adjustment') $$,
  '42501',
  null,
  'A sales user cannot write to the ledger directly'
);

select throws_ok(
  $$ update public.stock_levels set quantity = 9999 $$,
  '42501',
  null,
  'A sales user cannot edit the running total'
);

select throws_ok(
  $$ select public.record_stock_movements(
       'cccccccc-0000-0000-0000-000000000001',
       'adjustment',
       '[{"variant_id":"cccccccc-0000-0000-0000-000000000003","quantity_delta":100}]'::jsonb
     ) $$,
  '42501',
  null,
  'A sales user cannot make a stock adjustment through the RPC either'
);

-- --- Nobody promotes themselves -------------------------------------------

select throws_ok(
  $$ update public.staff set role = 'admin'
      where id = 'cccccccc-0000-0000-0000-00000000000c' $$,
  '42501',
  null,
  'A sales user cannot promote themselves to admin'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- Packing staff cannot sell ---------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.create_store_sale(
       'cccccccc-0000-0000-0000-000000000001',
       'cash',
       '[{"variant_id":"cccccccc-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
       'rls-sale-key-00001'
     ) $$,
  '42501',
  null,
  'A packing user cannot ring up a sale'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- Stock managers can do their job ---------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-00000000000b"}';

select isnt_empty(
  $$ select cost_egp from public.variant_costs $$,
  'A stock manager can read unit costs'
);

select lives_ok(
  $$ select public.record_stock_movements(
       'cccccccc-0000-0000-0000-000000000001',
       'adjustment',
       '[{"variant_id":"cccccccc-0000-0000-0000-000000000003","quantity_delta":-1}]'::jsonb,
       'stocktake', 'ST-1', 'One cap found damaged'
     ) $$,
  'A stock manager can make a stock adjustment'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- The last admin cannot be removed --------------------------------------

delete from public.staff where role = 'admin' and id <> 'cccccccc-0000-0000-0000-00000000000a';

select throws_ok(
  $$ update public.staff set is_active = false
      where id = 'cccccccc-0000-0000-0000-00000000000a' $$,
  '23001',
  null,
  'The last active admin cannot be deactivated, which would lock everyone out'
);

select * from finish();
rollback;
