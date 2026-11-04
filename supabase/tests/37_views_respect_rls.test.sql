-- ---------------------------------------------------------------------------
-- Every view reads as the person asking, none as the database owner.
--
-- What matters: a CREATE OR REPLACE VIEW that leaves out
-- WITH (security_invoker = on) silently resets the option, and the view then
-- skips row security - which is how v_settlement_totals and
-- v_settlement_breakdown came to show every statement's money to anyone
-- signed in. The migration put the option back and left a guard; this holds
-- the guard up against every view, so the next rewrite cannot slip out the
-- same way.
-- ---------------------------------------------------------------------------

begin;
select plan(4);

-- The sweep itself: every view in public runs as the asker.
select lives_ok(
  $$select public.assert_views_respect_rls()$$,
  'every view in public has security_invoker = on'
);

-- The two that regressed, by name, so a failure here reads instantly.
select is(
  (select (select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'v_settlement_totals'),
  'on'::text,
  'v_settlement_totals reads as the asker again'
);

select is(
  (select (select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'v_settlement_breakdown'),
  'on'::text,
  'v_settlement_breakdown reads as the asker again'
);

-- The guard really raises: a view made without the clause fails the sweep.
create view public.v_test_owner_eyes as select 1 as one;
select throws_like(
  $$select public.assert_views_respect_rls()$$,
  '%v_test_owner_eyes%',
  'a view without the clause is named the moment the guard runs'
);
drop view public.v_test_owner_eyes;

select * from finish();
rollback;
