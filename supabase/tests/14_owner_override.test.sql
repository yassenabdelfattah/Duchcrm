-- ---------------------------------------------------------------------------
-- The owner mark, reopening a paid order, and one sync issue per product.
--
-- The point of the owner mark is that it holds against admins: several
-- people are admin, and none of them may grant it, remove it, or lock the
-- owner out.
-- ---------------------------------------------------------------------------

begin;
select plan(19);

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('0a0a0a0a-0000-0000-0000-00000000000a', 'owner@test.local',  'authenticated', 'authenticated'),
  ('0a0a0a0a-0000-0000-0000-00000000000b', 'admin2@test.local', 'authenticated', 'authenticated'),
  ('0a0a0a0a-0000-0000-0000-00000000000c', 'sales9@test.local', 'authenticated', 'authenticated');

update public.staff set role = 'admin', is_active = true where id in (
  '0a0a0a0a-0000-0000-0000-00000000000a', '0a0a0a0a-0000-0000-0000-00000000000b');
update public.staff set role = 'sales', is_active = true where id = '0a0a0a0a-0000-0000-0000-00000000000c';

-- Set the way the real one is: in the database, as the service.
update public.staff set is_owner = true where id = '0a0a0a0a-0000-0000-0000-00000000000a';

insert into public.locations (id, name, type, is_default, is_active)
values ('0a0a0a0a-0000-0000-0000-000000000001', 'Owner Test Shop', 'store', false, true);

-- Rung up as cash and so born paid - but nobody had paid. Plus a paid order
-- that sits on a courier statement, and one that is not paid at all.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  payment_method, subtotal_egp, shipping_egp, total_egp
) values
  ('0a0a0a0a-0000-0000-0000-0000000000a1', 'OWNER-WRONG-CASH', 'store', 'delivered', 'paid',
   '0a0a0a0a-0000-0000-0000-000000000001', 'cash', 1200, 0, 1200),
  ('0a0a0a0a-0000-0000-0000-0000000000a2', 'OWNER-SETTLED', 'online', 'delivered', 'paid',
   '0a0a0a0a-0000-0000-0000-000000000001', 'cod', 900, 70, 900),
  ('0a0a0a0a-0000-0000-0000-0000000000a3', 'OWNER-UNPAID', 'dm', 'delivered', 'pending',
   '0a0a0a0a-0000-0000-0000-000000000001', 'deferred', 500, 0, 500);

insert into public.courier_settlements (id, reference, statement_date, status)
values ('0a0a0a0a-0000-0000-0000-0000000000f1', 'OWNER-TEST-STATEMENT', current_date, 'draft');
insert into public.settlement_lines (settlement_id, order_id, outcome, collected_egp, fee_egp)
values ('0a0a0a0a-0000-0000-0000-0000000000f1', '0a0a0a0a-0000-0000-0000-0000000000a2', 'delivered', 900, 0);

-- --- Nobody grants the owner mark from the app -----------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"0a0a0a0a-0000-0000-0000-00000000000b"}';

select throws_ok(
  $$ update public.staff set is_owner = true where id = '0a0a0a0a-0000-0000-0000-00000000000b' $$,
  '42501', null,
  'An admin cannot make themselves the owner'
);

select throws_ok(
  $$ update public.staff set role = 'sales' where id = '0a0a0a0a-0000-0000-0000-00000000000a' $$,
  '42501', null,
  'Another admin cannot demote the owner'
);

select throws_ok(
  $$ update public.staff set is_active = false where id = '0a0a0a0a-0000-0000-0000-00000000000a' $$,
  '42501', null,
  'Or lock the owner out'
);

select lives_ok(
  $$ update public.staff set full_name = 'Owner (renamed)' where id = '0a0a0a0a-0000-0000-0000-00000000000a' $$,
  'But can still correct the owner''s name'
);

select is(public.is_owner(), false, 'An admin is not the owner');

select throws_ok(
  $$ select public.reopen_order_payment('0a0a0a0a-0000-0000-0000-0000000000a1', 'deferred', 'Wrong button') $$,
  '42501', null,
  'An admin who is not the owner cannot reopen a paid order'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- The owner --------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"0a0a0a0a-0000-0000-0000-00000000000a"}';

select is(public.is_owner(), true, 'The owner is recognised');

select throws_ok(
  $$ update public.staff set is_owner = false where id = '0a0a0a0a-0000-0000-0000-00000000000a' $$,
  '42501', null,
  'Not even the owner changes the owner mark from the app'
);

select throws_ok(
  $$ select public.reopen_order_payment('0a0a0a0a-0000-0000-0000-0000000000a1', 'deferred', '  ') $$,
  '22023', null,
  'Reopening needs a reason'
);

select throws_ok(
  $$ select public.reopen_order_payment('0a0a0a0a-0000-0000-0000-0000000000a2', 'cod', 'Testing') $$,
  '23001', null,
  'An order on a courier statement stays locked, even for the owner'
);

select throws_ok(
  $$ select public.reopen_order_payment('0a0a0a0a-0000-0000-0000-0000000000a3', 'cash', 'Testing') $$,
  '23514', null,
  'An order that is not paid has nothing to reopen'
);

select lives_ok(
  $$ select public.reopen_order_payment(
       '0a0a0a0a-0000-0000-0000-0000000000a1', 'deferred', 'Rung up as cash but the customer pays Thursday') $$,
  'The owner reopens a payment recorded by mistake'
);

select results_eq(
  $$ select payment_status::text, payment_method::text
       from public.orders where id = '0a0a0a0a-0000-0000-0000-0000000000a1' $$,
  $$ values ('pending'::text, 'deferred'::text) $$,
  'It is unpaid again, with the right payment method'
);

select results_eq(
  $$ select note, details ->> 'from_method', details ->> 'to_method', staff_id
       from public.order_events
      where order_id = '0a0a0a0a-0000-0000-0000-0000000000a1' and event_type = 'payment_reopened' $$,
  $$ values ('Rung up as cash but the customer pays Thursday'::text, 'cash'::text, 'deferred'::text,
             '0a0a0a0a-0000-0000-0000-00000000000a'::uuid) $$,
  'The history says why, what it was, what it became, and who did it'
);

select lives_ok(
  $$ select public.update_order_details('0a0a0a0a-0000-0000-0000-0000000000a1', p_discount_egp => 100) $$,
  'Its money is open again, so the ordinary editor works on it'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- A sales user --------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"0a0a0a0a-0000-0000-0000-00000000000c"}';

select is(public.is_owner(), false, 'A sales user is not the owner');

reset role;
select set_config('request.jwt.claims', '', true);

-- --- One open issue per product -------------------------------------------

select public.open_sync_issue('missing_in_crm', null, null, null, null,
  '{"reason":"variants_without_sku","shopify_product_id":880001,"count":4}'::jsonb, 'webhook');
select public.open_sync_issue('missing_in_crm', null, null, null, null,
  '{"reason":"variants_without_sku","shopify_product_id":880002,"count":10}'::jsonb, 'webhook');
select public.open_sync_issue('missing_in_crm', null, null, null, null,
  '{"reason":"variants_without_sku","shopify_product_id":880002,"count":10}'::jsonb, 'webhook');

select is(
  (select count(*)::int from public.sync_issues
    where status = 'open' and details ->> 'shopify_product_id' in ('880001', '880002')),
  2,
  'Two products missing SKUs are two issues, not one overwritten by the other'
);

select is(
  (select occurrences from public.sync_issues
    where status = 'open' and details ->> 'shopify_product_id' = '880002'),
  2,
  'The same product seen again is still one issue'
);

select is(
  (select details ->> 'count' from public.sync_issues
    where status = 'open' and details ->> 'shopify_product_id' = '880001'),
  '4',
  'And the first product keeps its own details'
);

select * from finish();
rollback;
