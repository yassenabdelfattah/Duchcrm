-- ---------------------------------------------------------------------------
-- Local development seed. Runs on `supabase db reset`.
--
-- This never runs against production. It creates fake staff logins so you can
-- try each role without inviting real people.
--
-- Logins (password is the same for all): duch-dev-password
--   admin@duch.local          admin
--   stock@duch.local          stock_manager
--   sales@duch.local          sales
--   packing@duch.local        packing
-- ---------------------------------------------------------------------------

-- --- Fake auth users -------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
select
  '00000000-0000-0000-0000-000000000000',
  u.id,
  'authenticated',
  'authenticated',
  u.email,
  crypt('duch-dev-password', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name)
from (values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'admin@duch.local',   'Yassen (Admin)'),
  ('22222222-2222-2222-2222-222222222222'::uuid, 'stock@duch.local',   'Mona Stock Manager'),
  ('33333333-3333-3333-3333-333333333333'::uuid, 'sales@duch.local',   'Karim Sales'),
  ('44444444-4444-4444-4444-444444444444'::uuid, 'packing@duch.local', 'Hassan Packing')
) as u(id, email, full_name)
on conflict (id) do nothing;

insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email),
  'email', now(), now(), now()
from auth.users u
where u.email like '%@duch.local'
on conflict do nothing;

-- The on_auth_user_created trigger made these rows as inactive 'sales'.
-- Promote them to the roles we want to test with.
update public.staff set role = 'admin',         is_active = true
  where id = '11111111-1111-1111-1111-111111111111';
update public.staff set role = 'stock_manager', is_active = true
  where id = '22222222-2222-2222-2222-222222222222';
update public.staff set role = 'sales',         is_active = true
  where id = '33333333-3333-3333-3333-333333333333';
update public.staff set role = 'packing',       is_active = true
  where id = '44444444-4444-4444-4444-444444444444';

-- --- A location ------------------------------------------------------------

insert into public.locations (id, name, name_ar, type, is_default, shopify_location_id)
values (
  '55555555-5555-5555-5555-555555555555',
  'Duch Store - Maadi', 'دوتش - المعادي', 'store', true, 1234567890
)
on conflict (id) do nothing;

-- --- A little catalogue ----------------------------------------------------

insert into public.products (id, title, title_ar, handle, product_type, status, tags)
values
  ('66666666-6666-6666-6666-666666666601', 'Duch Boxy Hoodie', 'هودي دوتش واسع',
   'duch-boxy-hoodie', 'Hoodie', 'active', array['fw26', 'core']),
  ('66666666-6666-6666-6666-666666666602', 'Duch Cargo Pants', 'بنطلون كارجو دوتش',
   'duch-cargo-pants', 'Pants', 'active', array['fw26'])
on conflict (id) do nothing;

insert into public.variants (product_id, sku, barcode, size, color, price_egp, low_stock_threshold, shopify_inventory_item_id)
values
  ('66666666-6666-6666-6666-666666666601', 'DCH-HOOD-BLK-S',  '6221000000011', 'S',  'Black', 1450.00, 3, 900000000001),
  ('66666666-6666-6666-6666-666666666601', 'DCH-HOOD-BLK-M',  '6221000000028', 'M',  'Black', 1450.00, 3, 900000000002),
  ('66666666-6666-6666-6666-666666666601', 'DCH-HOOD-BLK-L',  '6221000000035', 'L',  'Black', 1450.00, 3, 900000000003),
  ('66666666-6666-6666-6666-666666666601', 'DCH-HOOD-BEI-M',  '6221000000042', 'M',  'Beige', 1450.00, 3, 900000000004),
  ('66666666-6666-6666-6666-666666666602', 'DCH-CARG-OLV-M',  '6221000000059', 'M',  'Olive', 1850.00, 2, 900000000005),
  ('66666666-6666-6666-6666-666666666602', 'DCH-CARG-OLV-L',  '6221000000066', 'L',  'Olive', 1850.00, 2, 900000000006)
on conflict (sku) do nothing;

insert into public.variant_costs (variant_id, cost_egp)
select id, round(price_egp * 0.38, 2) from public.variants
on conflict (variant_id) do nothing;

-- --- Opening stock ---------------------------------------------------------
--
-- Written through the ledger, exactly like every other stock change. There is
-- deliberately no way to seed a quantity directly.

select public.record_stock_movements(
  p_location_id    => '55555555-5555-5555-5555-555555555555',
  p_reason         => 'initial_import',
  p_movements      => (
    select jsonb_agg(jsonb_build_object('variant_id', id, 'quantity_delta', 12))
      from public.variants
  ),
  p_reference_type => 'seed',
  p_reference_id   => 'local-dev',
  p_note           => 'Opening stock for local development'
);

-- --- A customer ------------------------------------------------------------

insert into public.customers (full_name, phone, instagram_handle, city, governorate)
values ('Nour Ahmed', '+20 100 123 4567', '@nour.wears', 'Maadi', 'Cairo')
on conflict do nothing;
