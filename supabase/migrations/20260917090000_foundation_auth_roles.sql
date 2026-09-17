-- ---------------------------------------------------------------------------
-- Phase 1: staff accounts, roles, and the helpers every RLS policy depends on.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";
create extension if not exists "citext";
-- Trigram indexes power the "type any part of a SKU or product name" search
-- on the in-store sale screen.
create extension if not exists "pg_trgm";

-- --- Roles -----------------------------------------------------------------

create type public.staff_role as enum ('admin', 'stock_manager', 'sales', 'packing');

create table public.staff (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null,
  phone       text,
  role        public.staff_role not null default 'sales',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.staff is
  'One row per person who can log in. Mirrors auth.users and holds the role.';

create index staff_role_idx on public.staff (role) where is_active;

-- --- updated_at ------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger staff_touch_updated_at
  before update on public.staff
  for each row execute function public.touch_updated_at();

-- --- Putting the role into the JWT -----------------------------------------
--
-- Supabase calls this hook while minting an access token, so the dashboard can
-- read the signed-in user's role straight out of the token and decide which
-- menu items to render without an extra round trip.
--
-- This claim is a UI convenience and nothing more. Security decisions read
-- public.staff instead - see the note on auth_role() below for why.
--
-- Enable it once per project:
--   Dashboard -> Authentication -> Hooks -> Customize Access Token (JWT) Claims
--   -> select public.custom_access_token_hook
-- The app works correctly without it; the sidebar just renders a moment later.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_claims jsonb;
  v_role   public.staff_role;
  v_active boolean;
begin
  select s.role, s.is_active
    into v_role, v_active
    from public.staff s
   where s.id = (event ->> 'user_id')::uuid;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);

  if v_claims -> 'app_metadata' is null then
    v_claims := jsonb_set(v_claims, '{app_metadata}', '{}'::jsonb);
  end if;

  -- An inactive account advertises no role, so the dashboard renders the
  -- "your account is not active yet" screen rather than an empty sidebar.
  v_claims := jsonb_set(
    v_claims,
    '{app_metadata,staff_role}',
    case
      when v_role is null or not coalesce(v_active, false) then 'null'::jsonb
      else to_jsonb(v_role::text)
    end
  );
  v_claims := jsonb_set(
    v_claims,
    '{app_metadata,staff_active}',
    to_jsonb(coalesce(v_active, false))
  );

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant select on table public.staff to supabase_auth_admin;

-- --- Role helpers used by every policy -------------------------------------
--
-- security definer so the staff lookup in the fallback path is not itself
-- subject to RLS on public.staff.

-- Reads public.staff rather than the JWT claim, deliberately.
--
-- Trusting the claim would be marginally faster, but an access token is valid
-- for an hour after it is issued. If a staff member leaves on Tuesday morning,
-- a claim-based check would keep letting them sell stock until their token
-- happened to expire. Reading the table means "deactivate this person" takes
-- effect on their very next request.
--
-- The cost is one primary-key lookup. Every policy calls this as
-- (select public.auth_role()), which Postgres evaluates once per statement
-- rather than once per row, so a thousand-row product list still does exactly
-- one lookup.
--
-- security definer so that reading public.staff here is not itself filtered by
-- the policies on public.staff - that would recurse.
create or replace function public.auth_role()
returns public.staff_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.role
    from public.staff s
   where s.id = auth.uid()
     and s.is_active;
$$;

comment on function public.auth_role() is
  'Role of the calling user, or null if they are not an active staff member. '
  'Reads public.staff so that deactivation takes effect immediately.';

-- Named has_any_role rather than the more obvious has_role on purpose.
-- pgTAP - which Supabase installs for `supabase test db` - defines its own
-- public.has_role(name) and public.has_role(name, text), both returning text.
-- With those present, public.has_role('stock_manager') resolves to pgTAP's
-- overload and a policy silently gets text where it expected a boolean.
create or replace function public.has_any_role(variadic p_roles public.staff_role[])
returns boolean
language sql
stable
as $$
  select public.auth_role() = any (p_roles);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select public.auth_role() = 'admin';
$$;

-- True for Edge Functions and the Worker, which connect with the service role
-- key and therefore have no end user attached to the request.
create or replace function public.is_service_request()
returns boolean
language sql
stable
as $$
  select auth.uid() is null;
$$;

-- --- Guard against privilege escalation ------------------------------------
--
-- Staff may edit their own name and phone. Without this trigger, the policy
-- that allows that would also let a sales user set their own role to admin.

create or replace function public.staff_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_admin() or public.is_service_request() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'Only an admin can change a staff role'
      using errcode = 'insufficient_privilege';
  end if;

  if new.is_active is distinct from old.is_active then
    raise exception 'Only an admin can activate or deactivate staff'
      using errcode = 'insufficient_privilege';
  end if;

  if new.id is distinct from old.id then
    raise exception 'Staff id is immutable' using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger staff_guard_privileged_columns_trg
  before update on public.staff
  for each row execute function public.staff_guard_privileged_columns();

-- Prevent an admin from locking everyone out by demoting or disabling the
-- last remaining active admin.
create or replace function public.staff_protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_remaining int;
begin
  if tg_op = 'UPDATE'
     and old.role = 'admin' and old.is_active
     and (new.role <> 'admin' or not new.is_active)
  then
    select count(*) into v_remaining
      from public.staff
     where role = 'admin' and is_active and id <> old.id;

    if v_remaining = 0 then
      raise exception 'Cannot remove the last active admin'
        using errcode = 'restrict_violation';
    end if;
  end if;

  if tg_op = 'DELETE' and old.role = 'admin' and old.is_active then
    select count(*) into v_remaining
      from public.staff
     where role = 'admin' and is_active and id <> old.id;

    if v_remaining = 0 then
      raise exception 'Cannot delete the last active admin'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  return new;
end;
$$;

create trigger staff_protect_last_admin_update
  before update on public.staff
  for each row execute function public.staff_protect_last_admin();

create trigger staff_protect_last_admin_delete
  before delete on public.staff
  for each row execute function public.staff_protect_last_admin();

-- --- New signups -----------------------------------------------------------
--
-- Every auth user gets a staff row. New accounts start as 'sales' and inactive
-- so that someone signing up cannot see anything until an admin approves them.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.staff (id, full_name, phone, role, is_active)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    'sales',
    false
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
