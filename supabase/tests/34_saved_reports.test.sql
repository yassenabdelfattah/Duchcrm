-- ---------------------------------------------------------------------------
-- Reports kept by name.
--
-- What matters: whoever can see the reports can keep one, change it and
-- delete it; nobody else can see them; and two reports cannot share a name.
-- ---------------------------------------------------------------------------

begin;
select plan(8);

insert into public.roles (id, name_ar, permissions)
values
  ('fefefefe-0000-0000-0000-0000000000e1', 'تقارير فقط تجريبي', array['reports.read']),
  ('fefefefe-0000-0000-0000-0000000000e2', 'طلبات فقط تجريبي', array['orders.read']);
insert into auth.users (id, email, aud, role) values
  ('fefefefe-0000-0000-0000-00000000000a', 'saved-reports@test.local', 'authenticated', 'authenticated'),
  ('fefefefe-0000-0000-0000-00000000000b', 'saved-orders@test.local', 'authenticated', 'authenticated');
update public.staff set role_id = 'fefefefe-0000-0000-0000-0000000000e1', is_active = true
 where id = 'fefefefe-0000-0000-0000-00000000000a';
update public.staff set role_id = 'fefefefe-0000-0000-0000-0000000000e2', is_active = true
 where id = 'fefefefe-0000-0000-0000-00000000000b';

set local role authenticated;
set local request.jwt.claims = '{"sub":"fefefefe-0000-0000-0000-00000000000a"}';

select lives_ok(
  $$ insert into public.saved_reports (id, name, sections)
     values ('fefefefe-0000-0000-0000-0000000000f1', 'تقرير الشهر', array['summary', 'variants', 'top', 'returnRate']) $$,
  'Whoever can see the reports can keep one');
select is(
  (select row(include_open, created_by)::text from public.saved_reports where id = 'fefefefe-0000-0000-0000-0000000000f1'),
  row(true, 'fefefefe-0000-0000-0000-00000000000a')::text,
  'It counts open orders unless told otherwise, and says who made it');
select throws_ok(
  $$ insert into public.saved_reports (name, sections) values ('  تقرير الشهر ', array['summary']) $$,
  '23505', null, 'Two reports cannot share a name');
select throws_ok(
  $$ insert into public.saved_reports (name, sections) values ('فاضي', array[]::text[]) $$,
  '23514', null, 'A report has at least one part');
select lives_ok(
  $$ update public.saved_reports set sections = array['summary'], include_open = false
      where id = 'fefefefe-0000-0000-0000-0000000000f1' $$,
  'and can change it');

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"fefefefe-0000-0000-0000-00000000000b"}';

select is((select count(*)::int from public.saved_reports), 0, 'Someone without the reports sees none');
select throws_ok(
  $$ insert into public.saved_reports (name, sections) values ('x', array['summary']) $$,
  '42501', null, 'and cannot keep one');

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"fefefefe-0000-0000-0000-00000000000a"}';

delete from public.saved_reports where id = 'fefefefe-0000-0000-0000-0000000000f1';
select is((select count(*)::int from public.saved_reports where id = 'fefefefe-0000-0000-0000-0000000000f1'), 0,
  'Whoever can see the reports can delete one');

reset role;
select * from finish();
rollback;
