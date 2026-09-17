-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Two conventions used throughout:
--
-- 1. Helper calls are wrapped as (select public.auth_role()) rather than
--    public.auth_role(). Postgres treats the subquery as a one-off initplan
--    and evaluates it once for the whole statement instead of once per row.
--    On a variants table with a few thousand rows that is the difference
--    between a snappy list and a visibly slow one.
--
-- 2. Tables that must only be written through an RPC simply have no INSERT,
--    UPDATE or DELETE policy. The RPCs are SECURITY DEFINER so they are not
--    subject to RLS, which means "the only way to change stock is
--    record_stock_movements()" is a fact about the database rather than a
--    convention we hope everyone follows.
--
-- The service role key used by Edge Functions and the Worker bypasses RLS
-- entirely, which is exactly why it must never reach the browser.
-- ---------------------------------------------------------------------------

create or replace function public.is_staff()
returns boolean
language sql
stable
as $$
  select public.auth_role() is not null;
$$;

alter table public.staff                     enable row level security;
alter table public.locations                 enable row level security;
alter table public.products                  enable row level security;
alter table public.variants                  enable row level security;
alter table public.variant_costs             enable row level security;
alter table public.settings                  enable row level security;
alter table public.webhook_events            enable row level security;
alter table public.stock_movements           enable row level security;
alter table public.stock_levels              enable row level security;
alter table public.customers                 enable row level security;
alter table public.orders                    enable row level security;
alter table public.order_line_items          enable row level security;
alter table public.shopify_inventory_pushes  enable row level security;
alter table public.sync_issues               enable row level security;

-- --- Staff -----------------------------------------------------------------

create policy staff_select_all on public.staff
  for select to authenticated
  using ((select public.is_staff()));

create policy staff_update_self_or_admin on public.staff
  for update to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()))
  with check (id = (select auth.uid()) or (select public.is_admin()));

create policy staff_insert_admin on public.staff
  for insert to authenticated
  with check ((select public.is_admin()));

create policy staff_delete_admin on public.staff
  for delete to authenticated
  using ((select public.is_admin()));

-- --- Locations -------------------------------------------------------------

create policy locations_select on public.locations
  for select to authenticated
  using ((select public.is_staff()));

create policy locations_write on public.locations
  for all to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

-- --- Catalogue -------------------------------------------------------------

create policy products_select on public.products
  for select to authenticated
  using ((select public.is_staff()));

create policy products_write on public.products
  for all to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

create policy variants_select on public.variants
  for select to authenticated
  using ((select public.is_staff()));

create policy variants_write on public.variants
  for all to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

-- Cost is the margin. Sales and packing staff cannot read these rows at all.
create policy variant_costs_select on public.variant_costs
  for select to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')));

create policy variant_costs_write on public.variant_costs
  for all to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

-- --- Settings --------------------------------------------------------------

create policy settings_select on public.settings
  for select to authenticated
  using ((select public.is_staff()));

create policy settings_write on public.settings
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- --- Webhook inbox ---------------------------------------------------------
--
-- Raw Shopify payloads contain customer names, addresses and phone numbers.
-- Only admins can read them; nobody writes them from the browser.

create policy webhook_events_select_admin on public.webhook_events
  for select to authenticated
  using ((select public.is_admin()));

-- --- Stock -----------------------------------------------------------------
--
-- Read for every staff member. No write policy of any kind, for anyone: the
-- ledger is written only through record_stock_movements(), and the running
-- total only by the trigger behind it.

create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using ((select public.is_staff()));

create policy stock_levels_select on public.stock_levels
  for select to authenticated
  using ((select public.is_staff()));

-- --- Customers -------------------------------------------------------------

create policy customers_select on public.customers
  for select to authenticated
  using ((select public.is_staff()));

create policy customers_insert on public.customers
  for insert to authenticated
  with check ((select public.has_any_role('admin', 'stock_manager', 'sales')));

create policy customers_update on public.customers
  for update to authenticated
  using ((select public.has_any_role('admin', 'stock_manager', 'sales')))
  with check ((select public.has_any_role('admin', 'stock_manager', 'sales')));

create policy customers_delete_admin on public.customers
  for delete to authenticated
  using ((select public.is_admin()));

-- --- Orders ----------------------------------------------------------------
--
-- Created only through create_store_sale(); cancelled only through
-- cancel_order(). The update policy exists so a manager can correct a note,
-- not so anyone can rewrite totals - those columns are recomputed by the RPC.

create policy orders_select on public.orders
  for select to authenticated
  using ((select public.is_staff()));

create policy orders_update_manager on public.orders
  for update to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

create policy order_line_items_select on public.order_line_items
  for select to authenticated
  using ((select public.is_staff()));

-- --- Sync ------------------------------------------------------------------

create policy shopify_pushes_select on public.shopify_inventory_pushes
  for select to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')));

create policy sync_issues_select on public.sync_issues
  for select to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')));

-- Acknowledging an issue is a lightweight action; actually resolving one goes
-- through resolve_sync_issue(), which can append a stock adjustment.
create policy sync_issues_update on public.sync_issues
  for update to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

-- Table-level privileges are granted in the final grants migration, which runs
-- after every table and view exists.
