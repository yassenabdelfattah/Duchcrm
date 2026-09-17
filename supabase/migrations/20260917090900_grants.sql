-- ---------------------------------------------------------------------------
-- Table privileges. Runs last, so it covers every table and view above.
--
-- The model is the standard Supabase one: grant table privileges broadly to
-- `authenticated` and let Row Level Security decide which rows anyone actually
-- sees. Privileges answer "may you touch this table at all"; policies answer
-- "which rows". Both have to say yes.
--
-- This file is deliberately separate from the policies so the grants happen
-- after 090700 (views) and 090800 (the outbox), rather than silently missing
-- whatever was created later.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- The service role bypasses RLS, but still needs ordinary table privileges.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- --- The ledger is append-only at the privilege level too ------------------
--
-- There is already no INSERT policy and a trigger that refuses UPDATE and
-- DELETE. Removing the privilege as well means an attempt fails at the door
-- with a clear permission error, rather than deep inside a trigger.

revoke insert, update, delete on public.stock_movements from authenticated;
revoke insert, update, delete on public.stock_levels     from authenticated;
revoke insert, update, delete on public.order_line_items from authenticated;
revoke insert, delete          on public.orders          from authenticated;
revoke insert, update, delete on public.webhook_events   from authenticated;
revoke insert, update, delete on public.shopify_inventory_pushes from authenticated;
revoke insert, update, delete on public.sync_outbox      from authenticated;
revoke insert, delete          on public.sync_issues     from authenticated;

-- --- Anonymous callers get nothing -----------------------------------------
--
-- The anon key is public by design - it ships in the dashboard bundle. Nothing
-- in this schema should be reachable with it.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Anything added by a later migration inherits the same shape.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
