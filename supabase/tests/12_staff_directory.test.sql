-- ---------------------------------------------------------------------------
-- The staff screen's data access: staff_directory() is admin only, and the
-- ordinary staff table policies already let an admin activate a pending
-- signup and set its role. This pins both.
-- ---------------------------------------------------------------------------

begin;
select plan(6);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('dddddddd-0000-0000-0000-00000000000a', 'staffdir-admin@test.local',   'authenticated', 'authenticated'),
  ('dddddddd-0000-0000-0000-00000000000b', 'staffdir-sales@test.local',   'authenticated', 'authenticated'),
  ('dddddddd-0000-0000-0000-00000000000c', 'staffdir-pending@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'admin', is_active = true
 where id = 'dddddddd-0000-0000-0000-00000000000a';
update public.staff set role = 'sales', is_active = true
 where id = 'dddddddd-0000-0000-0000-00000000000b';
-- 'dddddddd...c' is left exactly as the signup trigger made it: sales, inactive.

-- --- An admin sees the directory, email included ---------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000000a"}';

select isnt_empty(
  $$ select id from public.staff_directory() $$,
  'An admin can read the staff directory'
);

select results_eq(
  $$ select email from public.staff_directory()
      where id = 'dddddddd-0000-0000-0000-00000000000c' $$,
  $$ values ('staffdir-pending@test.local'::text) $$,
  'The directory carries the email from auth.users'
);

-- --- An admin can activate a pending signup and set its role ---------------

select lives_ok(
  $$ update public.staff set role = 'packing', is_active = true
      where id = 'dddddddd-0000-0000-0000-00000000000c' $$,
  'An admin can activate a pending signup and assign it a role'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- Nobody else sees the directory -----------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000000b"}';

select is_empty(
  $$ select id from public.staff_directory() $$,
  'A sales user gets nothing from the staff directory, not an error'
);

select throws_ok(
  $$ update public.staff set role = 'admin'
      where id = 'dddddddd-0000-0000-0000-00000000000b' $$,
  '42501',
  null,
  'A sales user still cannot promote themselves through the same path an admin uses'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- An unapproved account sees nothing at all ------------------------------

-- Undo the activation from earlier so this still tests a pending account.
update public.staff set is_active = false, role = 'sales'
 where id = 'dddddddd-0000-0000-0000-00000000000c';

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-00000000000c"}';

select is_empty(
  $$ select id from public.staff_directory() $$,
  'A pending account gets nothing from the staff directory either'
);

reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
