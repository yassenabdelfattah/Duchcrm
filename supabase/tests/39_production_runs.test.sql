-- ---------------------------------------------------------------------------
-- The manufacturing log.
--
-- What matters: a run is saved whole and saving it changes no product's cost;
-- a total bill is shared over every piece of the run and a per-piece amount
-- stays as typed; applying a run - only when asked - gives each product the
-- run's lines from a date and keeps what the product sets aside; saving a run
-- again puts it right rather than adding another; and nobody without
-- profit.view reads the log or its receipts.
-- ---------------------------------------------------------------------------

begin;
select plan(17);

insert into public.roles (id, name_ar, permissions) values
  ('f9a9a9a9-0000-0000-0000-0000000000e1', 'تصنيع تجريبي', array['profit.view']),
  ('f9a9a9a9-0000-0000-0000-0000000000e2', 'تقارير بلا تصنيع تجريبي', array['reports.read', 'products.manage']);
insert into auth.users (id, email, aud, role) values
  ('f9a9a9a9-0000-0000-0000-00000000000a', 'runs-owner@test.local', 'authenticated', 'authenticated'),
  ('f9a9a9a9-0000-0000-0000-00000000000b', 'runs-none@test.local', 'authenticated', 'authenticated');
update public.staff set role_id = 'f9a9a9a9-0000-0000-0000-0000000000e1', is_active = true where id = 'f9a9a9a9-0000-0000-0000-00000000000a';
update public.staff set role_id = 'f9a9a9a9-0000-0000-0000-0000000000e2', is_active = true where id = 'f9a9a9a9-0000-0000-0000-00000000000b';

insert into public.products (id, title) values
  ('f9a9a9a9-0000-0000-0000-000000000001', 'Run Test Sweatpants Black'),
  ('f9a9a9a9-0000-0000-0000-000000000002', 'Run Test Sweatpants Grey'),
  ('f9a9a9a9-0000-0000-0000-000000000003', 'Run Test Hoodie');
insert into public.variants (id, product_id, sku, size, price_egp) values
  ('f9a9a9a9-0000-0000-0000-0000000000a1', 'f9a9a9a9-0000-0000-0000-000000000001', 'RT-SWP-BLK-M', 'M', 900);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f9a9a9a9-0000-0000-0000-00000000000a"}';

-- Black already has a cost, with what it sets aside.
select public.save_cost_sheet('f9a9a9a9-0000-0000-0000-000000000001', '2026-09-01', '[
  {"kind":"cost","label":"قماش","amount_egp":280},
  {"kind":"cost","label":"تفصيل","amount_egp":110},
  {"kind":"loss_reserve","label":"مخصص الشحن","amount_egp":40},
  {"kind":"gift_reserve","label":"مخصص الهدايا","amount_egp":20}]'::jsonb);

select lives_ok(
  $$ select public.save_production_run('f9a9a9a9-0000-0000-0000-0000000000f1', '2026-11-08', 'Cuffed sweatpants', 'tailor X',
       '[{"product_id":"f9a9a9a9-0000-0000-0000-000000000001","pieces":80},
         {"product_id":"f9a9a9a9-0000-0000-0000-000000000002","pieces":70}]'::jsonb,
       '[{"label":"قماش","basis":"total","amount_egp":45000},
         {"label":"تفصيل","basis":"per_piece","amount_egp":120},
         {"label":"تغليف","basis":"total","amount_egp":3750}]'::jsonb) $$,
  'A run of two products is saved as one entry');
select is(
  (select string_agg(label || '=' || per_piece_egp, ' ' order by position)
     from public.v_production_run_lines where run_id = 'f9a9a9a9-0000-0000-0000-0000000000f1'),
  'قماش=300.00 تفصيل=120.00 تغليف=25.00',
  'A total bill is shared over all 150 pieces; a per-piece amount stays as typed');
select is(
  (select count(*)::int from public.cost_sheets
    where product_id in ('f9a9a9a9-0000-0000-0000-000000000001', 'f9a9a9a9-0000-0000-0000-000000000002')),
  1, 'Saving the run changed no product''s cost');

select throws_ok(
  $$ select public.save_production_run(null, '2026-11-08', 'No pieces', null,
       '[{"product_id":"f9a9a9a9-0000-0000-0000-000000000001","pieces":0}]'::jsonb,
       '[{"label":"قماش","basis":"total","amount_egp":45000}]'::jsonb) $$,
  '22023', null, 'A total bill needs pieces to be shared over');
select throws_ok(
  $$ select public.save_production_run(null, '2026-11-08', 'No products', null, '[]'::jsonb,
       '[{"label":"قماش","basis":"per_piece","amount_egp":300}]'::jsonb) $$,
  '22023', null, 'A run needs a product');

-- Applied to both, from the day it was made.
select is(
  public.apply_production_run('f9a9a9a9-0000-0000-0000-0000000000f1',
    array['f9a9a9a9-0000-0000-0000-000000000001', 'f9a9a9a9-0000-0000-0000-000000000002']::uuid[], '2026-11-08'),
  2, 'Asked to, the run becomes the cost of both products');
select is(
  (select string_agg(l.kind || ':' || l.label || '=' || l.amount_egp, ' ' order by l.position)
     from public.cost_lines l join public.cost_sheets s on s.id = l.sheet_id
    where s.product_id = 'f9a9a9a9-0000-0000-0000-000000000001' and s.effective_from = '2026-11-08'),
  'cost:قماش=300.00 cost:تفصيل=120.00 cost:تغليف=25.00 loss_reserve:مخصص الشحن=40.00 gift_reserve:مخصص الهدايا=20.00',
  'with the run''s lines, and what the product set aside kept as it was');
select is(
  (select string_agg(l.kind || ':' || l.label || '=' || l.amount_egp, ' ' order by l.position)
     from public.cost_lines l join public.cost_sheets s on s.id = l.sheet_id
    where s.product_id = 'f9a9a9a9-0000-0000-0000-000000000002' and s.effective_from = '2026-11-08'),
  'cost:قماش=300.00 cost:تفصيل=120.00 cost:تغليف=25.00',
  'A product with no cost before gets the run''s lines alone');
select is(
  (select count(*)::int from public.cost_sheets
    where product_id = 'f9a9a9a9-0000-0000-0000-000000000001' and effective_from = '2026-09-01'),
  1, 'The old cost stays for what was ordered before');
select is(
  (select count(*)::int from public.production_run_products
    where run_id = 'f9a9a9a9-0000-0000-0000-0000000000f1' and applied_sheet_id is not null),
  2, 'and the run says it was applied');
select is(
  (select price_egp from public.variants where id = 'f9a9a9a9-0000-0000-0000-0000000000a1'),
  900.00, 'The selling price is not touched');

select throws_ok(
  $$ select public.apply_production_run('f9a9a9a9-0000-0000-0000-0000000000f1',
       array['f9a9a9a9-0000-0000-0000-000000000003']::uuid[], '2026-11-08') $$,
  '22023', null, 'A product that was not in the run cannot be given its cost');

-- Put right: the same id, one product fewer, a dearer tailor.
select lives_ok(
  $$ select public.save_production_run('f9a9a9a9-0000-0000-0000-0000000000f1', '2026-11-08', 'Cuffed sweatpants', null,
       '[{"product_id":"f9a9a9a9-0000-0000-0000-000000000001","pieces":100}]'::jsonb,
       '[{"label":"قماش","basis":"total","amount_egp":45000},
         {"label":"تفصيل","basis":"per_piece","amount_egp":130}]'::jsonb) $$,
  'Saved again under its id');
select is(
  (select row((select count(*) from public.production_runs where id = 'f9a9a9a9-0000-0000-0000-0000000000f1'),
              (select count(*) from public.production_run_products where run_id = 'f9a9a9a9-0000-0000-0000-0000000000f1'),
              (select string_agg(label || '=' || per_piece_egp, ' ' order by position)
                 from public.v_production_run_lines where run_id = 'f9a9a9a9-0000-0000-0000-0000000000f1'))::text),
  row(1, 1, 'قماش=450.00 تفصيل=130.00')::text,
  'the entry is replaced, not doubled');
select is(
  (select l.amount_egp from public.cost_lines l join public.cost_sheets s on s.id = l.sheet_id
    where s.product_id = 'f9a9a9a9-0000-0000-0000-000000000001' and s.effective_from = '2026-11-08' and l.label = 'تفصيل'),
  120.00, 'and the cost already applied waits to be applied again');

-- --- Without the permission -------------------------------------------------------------------

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f9a9a9a9-0000-0000-0000-00000000000b"}';

select is(
  (select (select count(*) from public.production_runs) + (select count(*) from public.production_run_lines)
        + (select count(*) from public.production_run_products) + (select count(*) from public.production_run_receipts)
        + (select count(*) from public.v_production_run_lines))::int,
  0, 'Someone without profit.view reads nothing of the log');
select throws_ok(
  $$ select public.apply_production_run('f9a9a9a9-0000-0000-0000-0000000000f1',
       array['f9a9a9a9-0000-0000-0000-000000000001']::uuid[], '2026-12-01') $$,
  '42501', null, 'and cannot apply a run');

select * from finish();
rollback;
