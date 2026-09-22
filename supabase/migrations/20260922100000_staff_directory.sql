-- ---------------------------------------------------------------------------
-- The staff screen: an admin-only read that adds email to public.staff, and
-- nothing else. Activating a new signup and changing a role were already
-- possible for an admin through ordinary updates to public.staff - the
-- staff_update_self_or_admin policy and the guard triggers in
-- 20260917090000_foundation_auth_roles.sql already cover that. What was
-- missing was a way to see who someone even is: public.staff has no email
-- column, and auth.users is not exposed to PostgREST (grants.sql never
-- touches that schema, deliberately), so a security_invoker view - the
-- pattern every other view in this project uses - would fail for anyone
-- querying it, admin included. A security definer function reads auth.users
-- as its owner instead, the same way public.auth_role() already does.
-- ---------------------------------------------------------------------------

create or replace function public.staff_directory()
returns table (
  id          uuid,
  email       text,
  full_name   text,
  phone       text,
  role        public.staff_role,
  is_active   boolean,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, u.email::text, s.full_name, s.phone, s.role, s.is_active, s.created_at
    from public.staff s
    join auth.users u on u.id = s.id
   where public.is_admin()
   order by s.full_name;
$$;

comment on function public.staff_directory() is
  'The staff list for the staff screen. Returns nothing for a non-admin '
  'caller rather than raising, the same fail-closed shape as an RLS policy.';

revoke execute on function public.staff_directory() from public, anon, authenticated;
grant execute on function public.staff_directory() to authenticated;
