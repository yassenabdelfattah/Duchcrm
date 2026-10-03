-- ---------------------------------------------------------------------------
-- A stock count sets sizes to what was counted, by appending the difference,
-- and moves nothing for a size that was already right.
-- ---------------------------------------------------------------------------

begin;
select plan(8);

insert into auth.users (id, email, aud, role) values
  ('fbfbfbfb-0000-0000-0000-00000000000b', 'count-stock@test.local',   'authenticated', 'authenticated'),
  ('fbfbfbfb-0000-0000-0000-00000000000d', 'count-packing@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'stock_manager', is_active = true where id = 'fbfbfbfb-0000-0000-0000-00000000000b';
update public.staff set role = 'packing',       is_active = true where id = 'fbfbfbfb-0000-0000-0000-00000000000d';

insert into public.locations (id, name, type, is_default, is_active)
values ('fbfbfbfb-0000-0000-0000-000000000001', 'Count Shop', 'store', false, true);

insert into public.products (id, title) values ('fbfbfbfb-0000-0000-0000-000000000002', 'Count Pants');
insert into public.variants (id, product_id, sku, price_egp) values
  ('fbfbfbfb-0000-0000-0000-0000000000a1', 'fbfbfbfb-0000-0000-0000-000000000002', 'COUNT-M', 490),
  ('fbfbfbfb-0000-0000-0000-0000000000a2', 'fbfbfbfb-0000-0000-0000-000000000002', 'COUNT-L', 490),
  ('fbfbfbfb-0000-0000-0000-0000000000a3', 'fbfbfbfb-0000-0000-0000-000000000002', 'COUNT-XL', 490);

select public.record_stock_movements(
  'fbfbfbfb-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a1","quantity_delta":5},
    {"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a2","quantity_delta":3}]'::jsonb
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"fbfbfbfb-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.record_stock_count('fbfbfbfb-0000-0000-0000-000000000001',
       '[{"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a1","counted":1}]'::jsonb, null, 'count-test-packing') $$,
  '42501', null,
  'A packing user cannot record a count'
);

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"fbfbfbfb-0000-0000-0000-00000000000b"}';

-- Counted: M 7 (was 5), L 3 (unchanged), XL 2 (never moved).
select is(
  (public.record_stock_count('fbfbfbfb-0000-0000-0000-000000000001',
     '[{"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a1","counted":7},
       {"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a2","counted":3},
       {"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a3","counted":2}]'::jsonb,
     'Saturday count', 'count-test-1') ->> 'changed')::int,
  2,
  'Two sizes changed'
);

select is(
  (select array_agg(quantity order by variant_id) from public.stock_levels
    where location_id = 'fbfbfbfb-0000-0000-0000-000000000001'),
  array[7, 3, 2],
  'Every size now holds what was counted, including one that never moved'
);

select is(
  (select array_agg(quantity_delta order by variant_id) from public.stock_movements
    where location_id = 'fbfbfbfb-0000-0000-0000-000000000001' and reference_type = 'stock_count'),
  array[2, 2],
  'Only the differences were written, as adjustments'
);

select is(
  (select count(*)::int from public.stock_movements
    where variant_id = 'fbfbfbfb-0000-0000-0000-0000000000a2' and reference_type = 'stock_count'),
  0,
  'A size counted at what the system said moves nothing'
);

select is(
  (public.record_stock_count('fbfbfbfb-0000-0000-0000-000000000001',
     '[{"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a1","counted":1}]'::jsonb, null, 'count-test-1') ->> 'repeat')::boolean,
  true,
  'A second tap with the same key does nothing'
);

select is(
  (select quantity from public.stock_levels where variant_id = 'fbfbfbfb-0000-0000-0000-0000000000a1'),
  7,
  'And the stock is unchanged by it'
);

select throws_ok(
  $$ select public.record_stock_count('fbfbfbfb-0000-0000-0000-000000000001',
       '[{"variant_id":"fbfbfbfb-0000-0000-0000-0000000000a1","counted":-1}]'::jsonb, null, 'count-test-negative') $$,
  '22023', null,
  'A count cannot be negative'
);

select * from finish();
rollback;
