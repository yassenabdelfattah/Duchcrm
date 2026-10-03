-- ---------------------------------------------------------------------------
-- Taking stock out for a reason: it leaves stock and tells Shopify, it can
-- never take more than there is, and pieces expected back are tracked until
-- they are.
-- ---------------------------------------------------------------------------

begin;
select plan(17);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('fafafafa-0000-0000-0000-00000000000b', 'out-stock@test.local',   'authenticated', 'authenticated'),
  ('fafafafa-0000-0000-0000-00000000000d', 'out-packing@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'stock_manager', is_active = true where id = 'fafafafa-0000-0000-0000-00000000000b';
update public.staff set role = 'packing',       is_active = true where id = 'fafafafa-0000-0000-0000-00000000000d';

insert into public.locations (id, name, type, is_default, is_active)
values ('fafafafa-0000-0000-0000-000000000001', 'Out Shop', 'store', false, true);

insert into public.products (id, title) values ('fafafafa-0000-0000-0000-000000000002', 'Out Hoodie');
insert into public.variants (id, product_id, sku, price_egp) values
  ('fafafafa-0000-0000-0000-0000000000a1', 'fafafafa-0000-0000-0000-000000000002', 'OUT-HOOD-M', 1200),
  ('fafafafa-0000-0000-0000-0000000000a2', 'fafafafa-0000-0000-0000-000000000002', 'OUT-HOOD-L', 1200);

select public.record_stock_movements(
  'fafafafa-0000-0000-0000-000000000001', 'production_in',
  '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a1","quantity_delta":5},
    {"variant_id":"fafafafa-0000-0000-0000-0000000000a2","quantity_delta":2}]'::jsonb
);

delete from public.sync_outbox where location_id = 'fafafafa-0000-0000-0000-000000000001';

-- --- Only stock people ---------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"fafafafa-0000-0000-0000-00000000000d"}';

select throws_ok(
  $$ select public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'gift', null,
       '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a1","quantity":1}]'::jsonb,
       null, null, false, null, 'out-test-packing') $$,
  '42501', null,
  'A packing user cannot take stock out'
);

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"fafafafa-0000-0000-0000-00000000000b"}';

-- --- A photoshoot ------------------------------------------------------------------

select lives_ok(
  $$ select public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'photoshoot', null,
       '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a1","quantity":2},
         {"variant_id":"fafafafa-0000-0000-0000-0000000000a1","quantity":1},
         {"variant_id":"fafafafa-0000-0000-0000-0000000000a2","quantity":1}]'::jsonb,
       'Studio team', 'Winter shoot', true, current_date + 7, 'out-test-shoot') $$,
  'A stock manager takes pieces out for a photoshoot'
);

select is(
  (select array_agg(l.quantity order by v.sku)
     from public.stock_out_lines l join public.variants v on v.id = l.variant_id
     join public.stock_outs o on o.id = l.stock_out_id
    where o.idempotency_key = 'out-test-shoot'),
  array[1, 2 + 1]::int[],  -- OUT-HOOD-L, then OUT-HOOD-M
  'The same item listed twice is one line'
);

select is(
  (select array_agg(quantity order by variant_id) from public.stock_levels
    where location_id = 'fafafafa-0000-0000-0000-000000000001'),
  array[2, 1],
  'The pieces leave stock'
);

select is(
  (select count(*)::int from public.stock_movements m
     join public.stock_outs o on o.id::text = m.reference_id
    where o.idempotency_key = 'out-test-shoot'
      and m.reason = 'stock_out' and m.reference_type = 'stock_out' and m.quantity_delta < 0),
  2,
  'Each line is a stock_out movement in the ledger'
);

select is(
  (select count(*)::int from public.sync_outbox where location_id = 'fafafafa-0000-0000-0000-000000000001'),
  2,
  'And Shopify is told'
);

select is(
  (public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'photoshoot', null,
     '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a1","quantity":2}]'::jsonb,
     null, null, true, null, 'out-test-shoot')).id,
  (select id from public.stock_outs where idempotency_key = 'out-test-shoot'),
  'A second tap returns the same stock-out'
);

select is(
  (select quantity from public.stock_levels where variant_id = 'fafafafa-0000-0000-0000-0000000000a1'),
  2,
  'And takes nothing more out'
);

-- --- Refusals --------------------------------------------------------------------------

select throws_ok(
  $$ select public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'damaged', null,
       '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a2","quantity":5}]'::jsonb,
       null, null, false, null, 'out-test-toomany') $$,
  '23514', null,
  'Taking out more than there is is refused'
);

select throws_ok(
  $$ select public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'other', '  ',
       '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a2","quantity":1}]'::jsonb,
       null, null, false, null, 'out-test-noreason') $$,
  '22023', null,
  'A custom reason needs words'
);

-- --- Coming back -----------------------------------------------------------------------

select is(
  (select row(status, outstanding)::text from public.v_stock_outs v
     join public.stock_outs o on o.id = v.id where o.idempotency_key = 'out-test-shoot'),
  row('out', 4)::text,
  'Four pieces are out and expected back'
);

select public.return_stock_out(
  (select id from public.stock_outs where idempotency_key = 'out-test-shoot'),
  jsonb_build_array(jsonb_build_object(
    'line_id', (select l.id from public.stock_out_lines l join public.stock_outs o on o.id = l.stock_out_id
                 where o.idempotency_key = 'out-test-shoot' and l.variant_id = 'fafafafa-0000-0000-0000-0000000000a1'),
    'quantity', 2)),
  'First two back'
);

select is(
  (select row(v.status, v.outstanding, sl.quantity)::text
     from public.v_stock_outs v
     join public.stock_outs o on o.id = v.id
     join public.stock_levels sl on sl.variant_id = 'fafafafa-0000-0000-0000-0000000000a1'
    where o.idempotency_key = 'out-test-shoot'),
  row('out', 2, 4)::text,
  'Two back in stock, two still out'
);

select throws_ok(
  format($$ select public.return_stock_out(%L, %L::jsonb) $$,
    (select id from public.stock_outs where idempotency_key = 'out-test-shoot'),
    jsonb_build_array(jsonb_build_object(
      'line_id', (select l.id from public.stock_out_lines l join public.stock_outs o on o.id = l.stock_out_id
                   where o.idempotency_key = 'out-test-shoot' and l.variant_id = 'fafafafa-0000-0000-0000-0000000000a1'),
      'quantity', 5))),
  '23514', null,
  'More cannot come back than went out'
);

select public.return_stock_out(
  (select id from public.stock_outs where idempotency_key = 'out-test-shoot'),
  (select jsonb_agg(jsonb_build_object('line_id', l.id, 'quantity', l.quantity - l.quantity_returned))
     from public.stock_out_lines l join public.stock_outs o on o.id = l.stock_out_id
    where o.idempotency_key = 'out-test-shoot')
);

select is(
  (select v.status from public.v_stock_outs v join public.stock_outs o on o.id = v.id
    where o.idempotency_key = 'out-test-shoot'),
  'returned',
  'Once everything is back, the stock-out is closed as returned'
);

-- --- Gone, kept, late ----------------------------------------------------------------------

select public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'gift', null,
  '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a2","quantity":1}]'::jsonb,
  'An influencer', null, false, null, 'out-test-gift');

select is(
  (select v.status from public.v_stock_outs v join public.stock_outs o on o.id = v.id
    where o.idempotency_key = 'out-test-gift'),
  'gone',
  'A gift is gone, not waited for'
);

select public.record_stock_out('fafafafa-0000-0000-0000-000000000001', 'other', 'Sample for the factory',
  '[{"variant_id":"fafafafa-0000-0000-0000-0000000000a1","quantity":1}]'::jsonb,
  'Factory', null, true, current_date - 1, 'out-test-late');

select is(
  (select v.status from public.v_stock_outs v join public.stock_outs o on o.id = v.id
    where o.idempotency_key = 'out-test-late'),
  'overdue',
  'A piece past its return date is late'
);

select public.close_stock_out((select id from public.stock_outs where idempotency_key = 'out-test-late'), 'Factory kept it');

select is(
  (select row(v.status, v.outstanding)::text from public.v_stock_outs v join public.stock_outs o on o.id = v.id
    where o.idempotency_key = 'out-test-late'),
  row('kept', 1)::text,
  'Deciding it is not coming back closes it as kept, moving no stock'
);

select * from finish();
rollback;
