-- ---------------------------------------------------------------------------
-- Custom roles: a role is a name and the permissions ticked for it, the
-- database enforces exactly those, and nobody can hand out more than they
-- hold.
-- ---------------------------------------------------------------------------

begin;
select plan(22);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('f9f9f9f9-0000-0000-0000-00000000000a', 'roles-admin@test.local',   'authenticated', 'authenticated'),
  ('f9f9f9f9-0000-0000-0000-00000000000b', 'roles-cashier@test.local', 'authenticated', 'authenticated'),
  ('f9f9f9f9-0000-0000-0000-00000000000c', 'roles-hr@test.local',      'authenticated', 'authenticated'),
  ('f9f9f9f9-0000-0000-0000-00000000000d', 'roles-new@test.local',     'authenticated', 'authenticated'),
  ('f9f9f9f9-0000-0000-0000-00000000000e', 'roles-stock@test.local',   'authenticated', 'authenticated');

update public.staff set role = 'admin', is_active = true where id = 'f9f9f9f9-0000-0000-0000-00000000000a';

-- A cashier: sells, sees orders and stock, records payments. Nothing else.
insert into public.roles (id, name_ar, permissions) values
  ('f9f9f9f9-0000-0000-0000-0000000000e1', 'كاشير تجريبي', array['sales.create', 'orders.read', 'orders.settle', 'stock.read']),
  ('f9f9f9f9-0000-0000-0000-0000000000e2', 'شؤون موظفين تجريبي', array['staff.manage', 'orders.read']),
  ('f9f9f9f9-0000-0000-0000-0000000000e3', 'مخزن فقط تجريبي', array['stock.read', 'stock.adjust']);

update public.staff set role_id = 'f9f9f9f9-0000-0000-0000-0000000000e1', is_active = true where id = 'f9f9f9f9-0000-0000-0000-00000000000b';
update public.staff set role_id = 'f9f9f9f9-0000-0000-0000-0000000000e2', is_active = true where id = 'f9f9f9f9-0000-0000-0000-00000000000c';
update public.staff set role_id = 'f9f9f9f9-0000-0000-0000-0000000000e3', is_active = true where id = 'f9f9f9f9-0000-0000-0000-00000000000e';

insert into public.locations (id, name, type, is_default, is_active)
values ('f9f9f9f9-0000-0000-0000-000000000001', 'Roles Shop', 'store', false, true);

insert into public.products (id, title) values ('f9f9f9f9-0000-0000-0000-000000000002', 'Roles Tee');
insert into public.variants (id, product_id, sku, price_egp)
values ('f9f9f9f9-0000-0000-0000-000000000003', 'f9f9f9f9-0000-0000-0000-000000000002', 'ROLES-TEE', 300);

insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('f9f9f9f9-0000-0000-0000-0000000000a1', 'ROLES-OWED', 'store', 'delivered', 'pending',
   'f9f9f9f9-0000-0000-0000-000000000001', 'deferred', 300, 0, 300),
  ('f9f9f9f9-0000-0000-0000-0000000000a2', 'ROLES-SHIP', 'dm', 'awaiting_confirmation', 'pending',
   'f9f9f9f9-0000-0000-0000-000000000001', 'cod', 300, 50, 300);

-- --- A custom role is recorded as such ------------------------------------------

select is(
  (select row(role::text, role_id::text)::text from public.staff where id = 'f9f9f9f9-0000-0000-0000-00000000000b'),
  row(null::text, 'f9f9f9f9-0000-0000-0000-0000000000e1')::text,
  'A custom role leaves the built-in role empty'
);

-- --- The cashier can do what was ticked, and nothing more ---------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f9f9f9f9-0000-0000-0000-00000000000b"}';

select ok(public.is_staff(), 'The cashier counts as staff');
select ok(not public.is_admin(), 'But not as an admin');

select lives_ok(
  $$ select public.mark_order_paid('f9f9f9f9-0000-0000-0000-0000000000a1') $$,
  'The cashier can record a payment'
);

select throws_ok(
  $$ select public.update_order_details('f9f9f9f9-0000-0000-0000-0000000000a2', p_note => 'x') $$,
  '42501', null,
  'But cannot edit an order'
);

select throws_ok(
  $$ select public.ship_order('f9f9f9f9-0000-0000-0000-0000000000a2', 'ROLES-1') $$,
  '42501', null,
  'Or ship one'
);

select throws_ok(
  $$ select public.record_stock_movements('f9f9f9f9-0000-0000-0000-000000000001', 'adjustment',
       '[{"variant_id":"f9f9f9f9-0000-0000-0000-000000000003","quantity_delta":5}]'::jsonb) $$,
  '42501', null,
  'Or adjust stock'
);

select throws_ok(
  $$ select public.save_role(null, 'أي دور', array['orders.read']) $$,
  '42501', null,
  'Or manage roles'
);

-- --- A custom stock role adjusts stock --------------------------------------------------

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f9f9f9f9-0000-0000-0000-00000000000e"}';

select lives_ok(
  $$ select public.record_stock_movements('f9f9f9f9-0000-0000-0000-000000000001', 'adjustment',
       '[{"variant_id":"f9f9f9f9-0000-0000-0000-000000000003","quantity_delta":5}]'::jsonb) $$,
  'A role with the stock permission can adjust stock'
);

-- --- Managing roles without handing out more than you hold ---------------------------------

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f9f9f9f9-0000-0000-0000-00000000000c"}';

select throws_ok(
  $$ select public.save_role(null, 'تحصيل تجريبي', array['orders.read', 'orders.settle']) $$,
  '42501', null,
  'Someone who manages staff cannot create a role with a permission they lack'
);

select lives_ok(
  $$ select public.save_role(null, 'عرض الطلبات تجريبي', array['orders.read']) $$,
  'But can create one within their own permissions'
);

select throws_ok(
  $$ update public.staff set role_id = 'f9f9f9f9-0000-0000-0000-0000000000e1', is_active = true
      where id = 'f9f9f9f9-0000-0000-0000-00000000000d' $$,
  '42501', null,
  'Or give someone a role with more than they have'
);

select lives_ok(
  $$ update public.staff
        set role_id = (select id from public.roles where name_ar = 'عرض الطلبات تجريبي'), is_active = true
      where id = 'f9f9f9f9-0000-0000-0000-00000000000d' $$,
  'They can give someone a role within their own permissions'
);

select throws_ok(
  $$ update public.staff set is_active = false where id = 'f9f9f9f9-0000-0000-0000-00000000000a' $$,
  '42501', null,
  'And cannot touch an admin'
);

-- --- What only an admin can do ----------------------------------------------------------

select set_config('request.jwt.claims', '', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f9f9f9f9-0000-0000-0000-00000000000a"}';

select throws_ok(
  $$ select public.save_role((select id from public.roles where builtin_role = 'sales'), 'المبيعات', array['orders.read']) $$,
  '23514', null,
  'The built-in roles cannot be changed'
);

select throws_ok(
  $$ select public.save_role(null, 'دور غريب', array['orders.read', 'everything.please']) $$,
  '22023', null,
  'A permission that does not exist is refused'
);

select throws_ok(
  $$ select public.save_role(null, 'كاشير تجريبي', array['orders.read']) $$,
  '23505', null,
  'Two roles cannot share a name'
);

select throws_ok(
  $$ select public.delete_role('f9f9f9f9-0000-0000-0000-0000000000e1') $$,
  '23514', null,
  'A role still given to someone cannot be deleted'
);

select is(
  (select array_length(permissions, 1) from public.roles where name_ar = 'كاشير تجريبي'),
  4,
  'The cashier role holds exactly the four permissions ticked'
);

update public.staff set role = 'sales' where id = 'f9f9f9f9-0000-0000-0000-00000000000b';

select lives_ok(
  $$ select public.delete_role('f9f9f9f9-0000-0000-0000-0000000000e1') $$,
  'Once nobody has it, a custom role can be deleted'
);

-- --- The last admin cannot be moved to a custom role --------------------------------------

select set_config('request.jwt.claims', '', true);
reset role;

update public.staff set is_active = false
 where role = 'admin' and id <> 'f9f9f9f9-0000-0000-0000-00000000000a';

select throws_ok(
  $$ update public.staff set role_id = 'f9f9f9f9-0000-0000-0000-0000000000e3'
      where id = 'f9f9f9f9-0000-0000-0000-00000000000a' $$,
  '23001', null,
  'The last active admin cannot be moved to a custom role'
);

select is(
  (select array_length(public.known_permissions(), 1)),
  14,
  'Fourteen permissions can be given'
);

select * from finish();
rollback;
