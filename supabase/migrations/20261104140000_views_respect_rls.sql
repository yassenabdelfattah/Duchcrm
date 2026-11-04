-- Every view reads as the person asking, none as the database owner (2026-11-04).
--
-- v_settlement_totals and v_settlement_breakdown were born with
-- security_invoker on (20260919100200, 20260920100000), but later rewrites
-- left the clause out (20260921180000, and 20261102090000 for the breakdown),
-- and CREATE OR REPLACE VIEW resets the option when it is not written. The
-- two views then ran with the owner's rights and skipped row security: any
-- signed-in account - sales, packing, even a signup not yet approved - could
-- read every statement's money through them, against the policy that says
-- settlements are the accountant's and the owner's business.
--
-- Setting the option back changes no data and no shape; the views simply
-- check the asker's rights again, as every other view here does.

alter view public.v_settlement_totals set (security_invoker = on);
alter view public.v_settlement_breakdown set (security_invoker = on);

-- And so it cannot slip out again unseen: a rewrite that drops the clause now
-- fails the moment it runs, not months later in a review.
create or replace function public.assert_views_respect_rls()
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_names text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_names
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'v'
     and coalesce(
           (select option_value::boolean
              from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'),
           false) is distinct from true;
  if v_names is not null then
    raise exception 'views running as owner instead of asker (add WITH (security_invoker = on)): %', v_names;
  end if;
end;
$$;

revoke execute on function public.assert_views_respect_rls() from public, anon;
grant execute on function public.assert_views_respect_rls() to authenticated, service_role;

comment on function public.assert_views_respect_rls() is
  'Raises if any view in public lacks security_invoker = on, i.e. would skip '
  'row security by running as the database owner. Called by the test suite; '
  'safe to call anywhere.';

select public.assert_views_respect_rls();
