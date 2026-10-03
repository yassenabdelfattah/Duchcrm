-- ---------------------------------------------------------------------------
-- Custom roles: a role is a name and a list of permissions.
--
-- The owner's call (2026-10-04): roles you name yourself, with exactly the
-- permissions you tick - a cashier who sells and records payments but does
-- not see reports, say. Until now the database knew four roles by name and
-- every check named the roles it allowed. Now every check names the
-- permission it needs, and a role is a row in public.roles.
--
-- The four existing roles become built-in rows whose permissions reproduce
-- exactly what each could do before; they cannot be edited or deleted. The
-- existing tests, which exercise those roles, are the proof.
--
-- staff.role is kept and stays in step with staff.role_id for the built-in
-- roles (it is null for a custom one), so everything that reads it - the
-- last-admin guard, the identity the dashboard loads, older tests - goes on
-- working. staff.role_id is what permissions are read from.
--
-- Nobody can hand out a permission they do not hold: not by creating or
-- editing a role, and not by giving someone a role. Only an admin can give
-- the admin role.
-- ---------------------------------------------------------------------------

-- --- The permissions -----------------------------------------------------------

create or replace function public.known_permissions()
returns text[]
language sql
immutable
as $$
  select array[
    'sales.create',        -- بيع جديد: the sale page, and orders taken by message
    'orders.read',         -- رؤية الطلبات
    'orders.settle',       -- تسجيل التحصيل
    'orders.edit',         -- تعديل الطلبات
    'orders.cancel',       -- إلغاء الطلبات
    'orders.ship',         -- الشحن والتجهيز
    'returns.manage',      -- المرتجعات
    'stock.read',          -- رؤية المخزون
    'stock.adjust',        -- تعديل وإخراج المخزون
    'products.manage',     -- المنتجات والأسعار
    'reports.read',        -- التقارير
    'settlements.manage',  -- التسويات
    'sync.manage',         -- مشاكل المزامنة
    'staff.manage'         -- الموظفون والأدوار
  ]::text[];
$$;

comment on function public.known_permissions() is
  'Every permission a role can be given. "*" (everything) belongs to the '
  'built-in admin role only.';

-- --- Roles -------------------------------------------------------------------

create table public.roles (
  id           uuid primary key default gen_random_uuid(),
  -- Set for the four roles that existed before custom roles, which keep
  -- their name in staff.role. Null for a role someone created.
  builtin_role public.staff_role unique,
  name_ar      text not null check (length(trim(name_ar)) > 0),
  permissions  text[] not null default '{}',
  created_by   uuid references public.staff (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index roles_name_unique_idx on public.roles (lower(trim(name_ar)));

comment on table public.roles is
  'What each role may do. Changed only through save_role() and delete_role().';

insert into public.roles (builtin_role, name_ar, permissions) values
  ('admin', 'مسؤول', array['*']),
  ('stock_manager', 'مسؤول المخزون', array[
     'sales.create', 'orders.read', 'orders.settle', 'orders.edit', 'orders.cancel',
     'orders.ship', 'returns.manage', 'stock.read', 'stock.adjust', 'products.manage',
     'reports.read', 'settlements.manage', 'sync.manage']),
  ('sales', 'المبيعات', array[
     'sales.create', 'orders.read', 'orders.settle', 'orders.edit', 'stock.read', 'reports.read']),
  ('packing', 'التعبئة', array[
     'orders.read', 'orders.ship', 'returns.manage', 'stock.read', 'reports.read']);

alter table public.roles enable row level security;

create policy roles_select on public.roles
  for select to authenticated
  using ((select public.is_staff()));

grant select on public.roles to authenticated;
revoke insert, update, delete on public.roles from authenticated, anon;

-- --- Which role each person has ---------------------------------------------------

alter table public.staff add column role_id uuid references public.roles (id);

-- Someone with a custom role has no built-in role. A new sign-up still
-- starts as an inactive 'sales' account, as before.
alter table public.staff alter column role drop not null;

comment on column public.staff.role_id is
  'The role permissions are read from. staff.role mirrors it for the built-in '
  'roles and is null for a custom one.';

-- Every existing role assignment, carried over as it is.
update public.staff s
   set role_id = r.id
  from public.roles r
 where r.builtin_role = s.role
   and s.role_id is null;

-- Keeps role and role_id in step whichever one a caller changes. Named to
-- run before the staff guards (triggers fire in name order), so the guards
-- see both columns already settled.
create or replace function public.staff_sync_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.role_id is null and new.role is not null then
      new.role_id := (select id from public.roles where builtin_role = new.role);
    elsif new.role_id is not null then
      new.role := (select builtin_role from public.roles where id = new.role_id);
    end if;
    return new;
  end if;

  if new.role_id is distinct from old.role_id then
    new.role := (select builtin_role from public.roles where id = new.role_id);
  elsif new.role is distinct from old.role then
    new.role_id := (select id from public.roles where builtin_role = new.role);
  end if;

  return new;
end;
$$;

create trigger staff_a_sync_role_trg
  before insert or update on public.staff
  for each row execute function public.staff_sync_role();

-- --- Reading permissions ------------------------------------------------------------

create or replace function public.my_permissions()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.permissions
    from public.staff s
    join public.roles r on r.id = s.role_id
   where s.id = auth.uid()
     and s.is_active;
$$;

comment on function public.my_permissions() is
  'The calling user''s permissions, or null if they are not an active staff '
  'member with a role. Reads the tables, so a change takes effect at once.';

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce('*' = any (perms) or p_permission = any (perms), false)
    from (select public.my_permissions() as perms) x;
$$;

-- Same meaning as before, now read from permissions: an active staff member
-- with a role, and the role that may do everything. One difference: these
-- used to answer null, not false, for a request with no user - which let the
-- service role through any check written without is_service_request(). The
-- two sync functions that relied on that now say so explicitly.
create or replace function public.is_staff()
returns boolean
language sql
stable
as $$
  select public.my_permissions() is not null;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce('*' = any (public.my_permissions()), false);
$$;

revoke execute on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated, service_role;
revoke execute on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated, service_role;

-- --- Nobody hands out more than they hold ------------------------------------------

create or replace function public.can_grant_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_service_request()
      or public.is_admin()
      or coalesce(
           (select r.permissions <@ coalesce(public.my_permissions(), '{}'::text[])
              from public.roles r where r.id = p_role_id),
           false);
$$;

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

  if new.id is distinct from old.id then
    raise exception 'Staff id is immutable' using errcode = 'insufficient_privilege';
  end if;

  if new.role_id is distinct from old.role_id
     or new.role is distinct from old.role
     or new.is_active is distinct from old.is_active then

    if not public.has_permission('staff.manage') then
      if new.is_active is distinct from old.is_active then
        raise exception 'Only an admin can activate or deactivate staff'
          using errcode = 'insufficient_privilege';
      end if;
      raise exception 'Only an admin can change a staff role'
        using errcode = 'insufficient_privilege';
    end if;

    -- An admin is changed only by an admin.
    if exists (select 1 from public.roles r where r.id = old.role_id and '*' = any (r.permissions)) then
      raise exception 'Only an admin can change an admin'
        using errcode = 'insufficient_privilege';
    end if;

    if new.role_id is distinct from old.role_id
       and new.role_id is not null
       and not public.can_grant_role(new.role_id) then
      raise exception 'You cannot give a role with permissions you do not have yourself'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

-- The owner's role and access stay the owner's to change - whichever column
-- a caller touches.
create or replace function public.staff_guard_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_service_request() then
    return new;
  end if;

  if tg_op = 'INSERT' and new.is_owner then
    raise exception 'The owner mark can only be set in the database'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' then
    if new.is_owner is distinct from old.is_owner then
      raise exception 'The owner mark can only be set in the database'
        using errcode = 'insufficient_privilege';
    end if;

    if old.is_owner
       and old.id is distinct from auth.uid()
       and (new.role is distinct from old.role
            or new.role_id is distinct from old.role_id
            or new.is_active is distinct from old.is_active) then
      raise exception 'Only the owner can change the owner''s own role or access'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

-- A custom role leaves staff.role null, and "null <> 'admin'" is not true -
-- so moving the last admin to a custom role used to slip past this check.
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
     and (new.role is distinct from 'admin' or not new.is_active)
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

-- --- Managing roles --------------------------------------------------------------------

create or replace function public.save_role(
  p_role_id     uuid,
  p_name_ar     text,
  p_permissions text[]
)
returns public.roles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  public.roles;
  v_perms text[];
  v_name  text := nullif(trim(p_name_ar), '');
begin
  if not public.has_permission('staff.manage') then
    raise exception 'You may not manage roles' using errcode = 'insufficient_privilege';
  end if;

  if v_name is null then
    raise exception 'Give the role a name' using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(array_agg(distinct p order by p), '{}') into v_perms
    from unnest(coalesce(p_permissions, '{}')) p;

  if exists (select 1 from unnest(v_perms) p where not (p = any (public.known_permissions()))) then
    raise exception 'Unknown permission in %', v_perms using errcode = 'invalid_parameter_value';
  end if;

  if not (public.is_admin() or v_perms <@ coalesce(public.my_permissions(), '{}'::text[])) then
    raise exception 'You cannot give a role with permissions you do not have yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.roles
              where lower(trim(name_ar)) = lower(v_name)
                and id is distinct from p_role_id) then
    raise exception 'A role called % already exists', v_name using errcode = 'unique_violation';
  end if;

  if p_role_id is null then
    insert into public.roles (name_ar, permissions, created_by)
    values (v_name, v_perms, auth.uid())
    returning * into v_role;
    return v_role;
  end if;

  select * into v_role from public.roles where id = p_role_id for update;
  if not found then
    raise exception 'Role % not found', p_role_id using errcode = 'no_data_found';
  end if;

  if v_role.builtin_role is not null then
    raise exception 'The built-in roles cannot be changed' using errcode = 'check_violation';
  end if;

  update public.roles
     set name_ar = v_name, permissions = v_perms, updated_at = now()
   where id = p_role_id
  returning * into v_role;

  return v_role;
end;
$$;

create or replace function public.delete_role(p_role_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  public.roles;
  v_count int;
begin
  if not public.has_permission('staff.manage') then
    raise exception 'You may not manage roles' using errcode = 'insufficient_privilege';
  end if;

  select * into v_role from public.roles where id = p_role_id for update;
  if not found then
    raise exception 'Role % not found', p_role_id using errcode = 'no_data_found';
  end if;

  if v_role.builtin_role is not null then
    raise exception 'The built-in roles cannot be changed' using errcode = 'check_violation';
  end if;

  select count(*) into v_count from public.staff where role_id = p_role_id;
  if v_count > 0 then
    raise exception 'This role is still given to % staff', v_count using errcode = 'check_violation';
  end if;

  delete from public.roles where id = p_role_id;
end;
$$;

revoke execute on function public.save_role(uuid, text, text[]) from public, anon;
grant execute on function public.save_role(uuid, text, text[]) to authenticated;
revoke execute on function public.delete_role(uuid) from public, anon;
grant execute on function public.delete_role(uuid) to authenticated;

-- --- The staff screen's list ----------------------------------------------------------

drop function if exists public.staff_directory();

create function public.staff_directory()
returns table (
  id         uuid,
  email      text,
  full_name  text,
  phone      text,
  role       public.staff_role,
  role_id    uuid,
  is_active  boolean,
  is_owner   boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, u.email::text, s.full_name, s.phone, s.role, s.role_id, s.is_active, s.is_owner, s.created_at
    from public.staff s
    join auth.users u on u.id = s.id
   where public.has_permission('staff.manage')
   order by s.full_name;
$$;

revoke execute on function public.staff_directory() from public, anon;
grant execute on function public.staff_directory() to authenticated;

-- --- Stock movements by reason ----------------------------------------------------------

create or replace function public.assert_can_move_stock(p_reason public.stock_movement_reason)
returns void
language plpgsql
stable
as $$
begin
  -- Edge Functions and the Worker use the service role key. They carry no end
  -- user, and they are the only callers allowed to record online_order and
  -- cancellation movements.
  if public.is_service_request() then
    return;
  end if;

  if not public.is_staff() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  if public.is_admin() then
    return;
  end if;

  case p_reason
    -- Selling at the counter.
    when 'store_sale' then
      if public.has_permission('sales.create') then return; end if;

    -- Goods physically back on the table and counted.
    when 'return' then
      if public.has_permission('returns.manage') then return; end if;

    -- Deciding a number should be different, or booking in production.
    when 'adjustment', 'production_in', 'initial_import', 'wholesale' then
      if public.has_permission('stock.adjust') then return; end if;

    else
      null;
  end case;

  raise exception 'Role % may not record a % movement',
    coalesce(public.auth_role()::text, 'custom'), p_reason
    using errcode = 'insufficient_privilege';
end;
$$;

-- --- Table access rules, by permission ----------------------------------------------------

drop policy courier_settlements_select on public.courier_settlements;
create policy courier_settlements_select on public.courier_settlements
  for select to authenticated
  using ((select public.has_permission('settlements.manage')));

drop policy courier_settlements_write on public.courier_settlements;
create policy courier_settlements_write on public.courier_settlements
  for all to authenticated
  using ((select public.has_permission('settlements.manage')))
  with check ((select public.has_permission('settlements.manage')));

drop policy settlement_lines_select on public.settlement_lines;
create policy settlement_lines_select on public.settlement_lines
  for select to authenticated
  using ((select public.has_permission('settlements.manage')));

drop policy customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert to authenticated
  with check ((select public.has_permission('sales.create') or public.has_permission('orders.edit')));

drop policy customers_update on public.customers;
create policy customers_update on public.customers
  for update to authenticated
  using ((select public.has_permission('sales.create') or public.has_permission('orders.edit')))
  with check ((select public.has_permission('sales.create') or public.has_permission('orders.edit')));

drop policy locations_write on public.locations;
create policy locations_write on public.locations
  for all to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));

-- Orders change through the order functions. A direct table update was open
-- to managers but nothing uses it; it is now an admin's alone.
drop policy orders_update_manager on public.orders;
create policy orders_update_manager on public.orders
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy products_write on public.products;
create policy products_write on public.products
  for all to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));

drop policy variants_write on public.variants;
create policy variants_write on public.variants
  for all to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));

drop policy variant_costs_select on public.variant_costs;
create policy variant_costs_select on public.variant_costs
  for select to authenticated
  using ((select public.has_permission('products.manage')));

drop policy variant_costs_write on public.variant_costs;
create policy variant_costs_write on public.variant_costs
  for all to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));

drop policy shopify_pushes_select on public.shopify_inventory_pushes;
create policy shopify_pushes_select on public.shopify_inventory_pushes
  for select to authenticated
  using ((select public.has_permission('sync.manage')));

drop policy sync_issues_select on public.sync_issues;
create policy sync_issues_select on public.sync_issues
  for select to authenticated
  using ((select public.has_permission('sync.manage')));

drop policy sync_issues_update on public.sync_issues;
create policy sync_issues_update on public.sync_issues
  for update to authenticated
  using ((select public.has_permission('sync.manage')))
  with check ((select public.has_permission('sync.manage')));

drop policy sync_outbox_select on public.sync_outbox;
create policy sync_outbox_select on public.sync_outbox
  for select to authenticated
  using ((select public.has_permission('sync.manage')));

drop policy staff_update_self_or_admin on public.staff;
create policy staff_update_self_or_admin on public.staff
  for update to authenticated
  using ((id = (select auth.uid())) or (select public.has_permission('staff.manage')))
  with check ((id = (select auth.uid())) or (select public.has_permission('staff.manage')));

-- --- Every guarded function, now asking for a permission --------------------------------
--
-- Generated from each function's current definition with only its role check
-- replaced, so nothing else about them changes.

-- add_settlement_adjustment
CREATE OR REPLACE FUNCTION public.add_settlement_adjustment(p_settlement_id uuid, p_label text, p_amount_egp numeric)
 RETURNS settlement_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_line   public.settlement_lines;
  v_amount numeric(12, 2) := round(coalesce(p_amount_egp, 0), 2);
  v_label  text := nullif(trim(coalesce(p_label, '')), '');
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may enter a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements
     where id = p_settlement_id and status = 'draft'
  ) then
    raise exception 'Settlement % is not open for editing', p_settlement_id
      using errcode = 'check_violation';
  end if;

  -- An unlabelled deduction is the thing nobody can explain in three months.
  if v_label is null then
    raise exception 'An adjustment needs a description'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_amount = 0 then
    raise exception 'An adjustment of zero changes nothing'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.settlement_lines (
    settlement_id, order_id, shipment_id, tracking_number,
    outcome, collected_egp, fee_egp, expected_egp, note
  )
  values (
    p_settlement_id, null, null, null,
    'adjustment',
    case when v_amount > 0 then v_amount else 0 end,
    case when v_amount < 0 then -v_amount else 0 end,
    null,
    v_label
  )
  returning * into v_line;

  return v_line;
end;
$function$;

-- add_settlement_line
CREATE OR REPLACE FUNCTION public.add_settlement_line(p_settlement_id uuid, p_tracking_number text, p_outcome settlement_outcome, p_collected_egp numeric DEFAULT NULL::numeric, p_fee_egp numeric DEFAULT 0, p_note text DEFAULT NULL::text)
 RETURNS settlement_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment  public.shipments;
  v_order     public.orders;
  v_line      public.settlement_lines;
  v_expected  numeric(12, 2);
  v_collected numeric(12, 2);
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may enter a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements
     where id = p_settlement_id and status = 'draft'
  ) then
    raise exception 'Settlement % is not open for editing', p_settlement_id
      using errcode = 'check_violation';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking_number)
   order by created_at desc
   limit 1;

  -- Run unconditionally rather than inside an "if found", so v_order is always
  -- assigned - to a row, or to nulls. A line whose code matches nothing is
  -- still recorded, and shows up as unmatched on the settlement total.
  select * into v_order from public.orders where id = v_shipment.order_id;

  -- The goods, after discount. NOT cod_amount_egp, which is what the customer
  -- handed over including the shipping Accurate keeps.
  v_expected := v_order.total_egp;

  if v_order.id is not null and exists (
    select 1 from public.settlement_lines
     where settlement_id = p_settlement_id and order_id = v_order.id
  ) then
    raise exception '% is already on this statement', v_order.order_number
      using errcode = 'unique_violation', hint = 'duplicate_settlement_line';
  end if;

  -- Pre-fill from what we already know, so a normal delivered line needs no
  -- typing beyond the code itself.
  v_collected := coalesce(
    p_collected_egp,
    case when p_outcome = 'delivered' then coalesce(v_expected, 0) else 0 end
  );

  insert into public.settlement_lines (
    settlement_id, order_id, shipment_id, tracking_number,
    outcome, collected_egp, fee_egp, expected_egp, note
  )
  values (
    p_settlement_id, v_order.id, v_shipment.id, trim(p_tracking_number),
    p_outcome, v_collected, coalesce(p_fee_egp, 0), v_expected, p_note
  )
  returning * into v_line;

  return v_line;
end;
$function$;

-- remove_settlement_line
CREATE OR REPLACE FUNCTION public.remove_settlement_line(p_line_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may edit a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements s
      join public.settlement_lines sl on sl.settlement_id = s.id
     where sl.id = p_line_id and s.status = 'draft'
  ) then
    raise exception 'That settlement has already been reviewed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  delete from public.settlement_lines where id = p_line_id;
end;
$function$;

-- review_settlement
CREATE OR REPLACE FUNCTION public.review_settlement(p_settlement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_settlement public.courier_settlements;
  v_lines_net  numeric(12, 2);
  v_paid       integer := 0;
  v_unmatched  integer;
  v_difference numeric(12, 2);
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may review a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_settlement
    from public.courier_settlements where id = p_settlement_id for update;

  if not found then
    raise exception 'Settlement % not found', p_settlement_id using errcode = 'no_data_found';
  end if;

  if v_settlement.status <> 'draft' then
    raise exception 'Settlement % has already been reviewed', v_settlement.reference
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(net_egp), 0),
         count(*) filter (where order_id is null and outcome <> 'adjustment')
    into v_lines_net, v_unmatched
    from public.settlement_lines where settlement_id = p_settlement_id;

  v_difference := coalesce(v_settlement.net_received_egp, v_lines_net) - v_lines_net;

  -- Money the courier says they sent must equal the lines that explain it.
  -- Refusing to close on a mismatch is the point: an unexplained difference is
  -- exactly the thing that would otherwise be shrugged off and forgotten.
  if abs(v_difference) > 0.009 then
    raise exception
      'Settlement does not balance: the bank received %, the lines add up to %, a difference of %',
      v_settlement.net_received_egp, v_lines_net, v_difference
      using errcode = 'check_violation',
            hint = 'settlement_out_of_balance';
  end if;

  -- Delivered and paid for. This is the only place an order becomes paid from
  -- the courier's cash, which is what keeps "delivered" and "we have the
  -- money" honestly separate.
  update public.orders o
     set payment_status = 'paid'
    from public.settlement_lines sl
   where sl.settlement_id = p_settlement_id
     and sl.order_id = o.id
     and sl.outcome = 'delivered'
     and o.payment_status = 'pending';

  get diagnostics v_paid = row_count;

  update public.courier_settlements
     set status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_settlement_id;

  return jsonb_build_object(
    'settlement_id', p_settlement_id,
    'orders_marked_paid', v_paid,
    'unmatched_lines', v_unmatched,
    'net_egp', v_lines_net
  );
end;
$function$;

-- update_settlement_line
CREATE OR REPLACE FUNCTION public.update_settlement_line(p_line_id uuid, p_outcome settlement_outcome DEFAULT NULL::settlement_outcome, p_collected_egp numeric DEFAULT NULL::numeric, p_fee_egp numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS settlement_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_line public.settlement_lines;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may edit a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements s
      join public.settlement_lines sl on sl.settlement_id = s.id
     where sl.id = p_line_id and s.status = 'draft'
  ) then
    raise exception 'That settlement has already been reviewed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  update public.settlement_lines
     set outcome       = coalesce(p_outcome, outcome),
         collected_egp = coalesce(p_collected_egp, collected_egp),
         fee_egp       = coalesce(p_fee_egp, fee_egp),
         note          = coalesce(p_note, note)
   where id = p_line_id
  returning * into v_line;

  return v_line;
end;
$function$;

-- lookup_shipment_for_settlement
CREATE OR REPLACE FUNCTION public.lookup_shipment_for_settlement(p_tracking text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_customer public.customers;
  v_settled  record;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may read settlements'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('found', false, 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Already on a statement. Worth knowing before it is keyed a second time.
  select s.reference, s.id into v_settled
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.order_id = v_order.id
   limit 1;

  return jsonb_build_object(
    'found', true,
    'tracking_number', v_shipment.tracking_number,
    'order_number', v_order.order_number,
    'fulfillment_status', v_order.fulfillment_status,
    'payment_status', v_order.payment_status,
    'customer_name', v_customer.full_name,
    'governorate', v_customer.governorate,
    'goods_egp', v_order.total_egp,
    'shipping_egp', v_order.shipping_egp,
    'expected_egp', v_shipment.cod_amount_egp,
    'already_on', v_settled.reference,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity,
               'unit_price_egp', li.unit_price_egp,
               'total_egp', li.total_egp
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       where li.order_id = v_order.id
    )
  );
end;
$function$;

-- cancel_order
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order     public.orders;
  v_movements jsonb := '[]'::jsonb;
  v_line      record;
begin
  if not (public.is_admin() or public.has_permission('orders.cancel') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may cancel an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'cancelled' then
    return v_order;
  end if;

  -- An order already with the courier cannot simply be cancelled; it has to
  -- come back first, which is the returns flow rather than this one.
  --
  -- A store sale is exempt. It is created already delivered, because the
  -- customer walked out with it, and voiding one at the counter is an ordinary
  -- thing to need to do.
  if v_order.channel <> 'store'
     and v_order.fulfillment_status in ('in_transit', 'out_for_delivery', 'delivered')
  then
    raise exception 'Order % is already with the courier or delivered. Record a return instead.',
      v_order.order_number
      using errcode = 'check_violation',
            hint = 'use_returns_flow';
  end if;

  -- Stock only comes back if it was taken in the first place. A store sale
  -- deducted at the till; an online order deducted when it was created.
  for v_line in
    select li.variant_id, li.quantity
      from public.order_line_items li
      join public.variants v on v.id = li.variant_id
     where li.order_id = p_order_id
       and v.track_inventory
  loop
    v_movements := v_movements || jsonb_build_object(
      'variant_id', v_line.variant_id,
      'quantity_delta', v_line.quantity
    );
  end loop;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'cancellation',
      p_movements       => v_movements,
      p_reference_type  => 'order_cancellation',
      p_reference_id    => v_order.id::text,
      p_note            => p_reason,
      p_idempotency_key => 'cancel:' || v_order.id::text
    );
  end if;

  update public.orders
     set fulfillment_status = 'cancelled',
         cancelled_at       = now(),
         cancelled_by       = auth.uid(),
         cancel_reason      = p_reason
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$function$;

-- mark_order_paid
CREATE OR REPLACE FUNCTION public.mark_order_paid(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders;
begin
  if not (public.is_admin()
          or public.has_permission('orders.settle')
          or public.is_service_request()) then
    raise exception 'Not allowed to settle an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'Unknown order %', p_order_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: tapping twice is not an error, and the second tap must not
  -- write a second payment event.
  if v_order.payment_status = 'paid' then
    return v_order;
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'A cancelled order cannot be marked paid'
      using errcode = 'check_violation';
  end if;

  if v_order.fulfillment_status in ('returned', 'return_in_transit') then
    raise exception 'Order % was returned, so nothing is owed on it', v_order.order_number
      using errcode = 'check_violation', hint = 'order_returned';
  end if;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set payment_status = 'paid'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$function$;

-- complete_own_delivery
CREATE OR REPLACE FUNCTION public.complete_own_delivery(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_shipment public.shipments;
begin
  -- The same people who can already settle a paying-later order.
  if not (public.is_admin()
          or public.has_permission('orders.settle')
          or public.is_service_request()) then
    raise exception 'Not allowed to record a delivery' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc
   limit 1
   for update;

  -- A second tap is not an error and must not write a second event.
  if v_shipment.courier = 'own' and v_shipment.status = 'delivered' then
    return v_order;
  end if;

  if v_shipment.id is null or v_shipment.courier <> 'own' or v_shipment.status <> 'out_for_delivery' then
    raise exception 'Order % is not out with one of our own drivers', v_order.order_number
      using errcode = 'check_violation';
  end if;

  update public.shipments
     set status = 'delivered', delivered_at = now()
   where id = v_shipment.id;

  -- Cash on delivery is paid now: the driver has handed it in. Any other
  -- method keeps its own status - a paying-later customer still owes it, and
  -- a transfer is still settled from the orders screen when it lands.
  update public.orders
     set fulfillment_status = 'delivered',
         payment_status = case
           when payment_method = 'cod' and payment_status = 'pending'
             then 'paid'::public.payment_status
           else payment_status
         end
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$function$;

-- update_order_details
CREATE OR REPLACE FUNCTION public.update_order_details(p_order_id uuid, p_shipping_egp numeric DEFAULT NULL::numeric, p_discount_egp numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text, p_payment_method payment_method DEFAULT NULL::payment_method, p_channel sales_channel DEFAULT NULL::sales_channel)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_shipping numeric(12, 2);
  v_discount numeric(12, 2);
  v_touches_money boolean;
begin
  if not (public.is_admin()
          or public.has_permission('orders.edit')
          or public.is_service_request()) then
    raise exception 'Not allowed to edit an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Unknown order %', p_order_id using errcode = 'no_data_found';
  end if;

  v_touches_money := p_shipping_egp is not null
                  or p_discount_egp is not null
                  or p_payment_method is not null
                  or p_channel is not null;

  -- A note is a correction to what someone wrote down, not to the money, so
  -- it stays editable on an order whose figures are now fixed.
  if v_touches_money then
    perform public.assert_order_money_editable(v_order);
  elsif v_order.cancelled_at is not null then
    raise exception 'Order % was cancelled and cannot be edited', v_order.order_number
      using errcode = 'check_violation', hint = 'order_cancelled';
  end if;

  v_shipping := round(coalesce(p_shipping_egp, v_order.shipping_egp), 2);
  v_discount := round(coalesce(p_discount_egp, v_order.discount_egp), 2);

  if v_shipping < 0 then
    raise exception 'Shipping cannot be negative' using errcode = 'invalid_parameter_value';
  end if;

  if v_discount < 0 then
    raise exception 'A discount cannot be negative' using errcode = 'invalid_parameter_value';
  end if;

  if v_discount > v_order.subtotal_egp then
    raise exception 'A discount of % is larger than the order subtotal of %',
      v_discount, v_order.subtotal_egp
      using errcode = 'check_violation';
  end if;

  update public.orders
     set shipping_egp   = v_shipping,
         discount_egp   = v_discount,
         total_egp      = round(v_order.subtotal_egp - v_discount, 2),
         note           = coalesce(p_note, note),
         payment_method = coalesce(p_payment_method, payment_method),
         channel        = coalesce(p_channel, channel)
   where id = p_order_id
  returning * into v_order;

  -- The status trigger records fulfillment and payment changes on its own,
  -- but an edit to the figures leaves no trace otherwise.
  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    p_order_id, 'edited',
    p_note,
    jsonb_strip_nulls(jsonb_build_object(
      'shipping_egp',   p_shipping_egp,
      'discount_egp',   p_discount_egp,
      'payment_method', p_payment_method,
      'channel',        p_channel
    )),
    auth.uid()
  );

  return v_order;
end;
$function$;

-- update_order_items
CREATE OR REPLACE FUNCTION public.update_order_items(p_order_id uuid, p_items jsonb)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order         public.orders;
  v_item          jsonb;
  v_variant       public.variants;
  v_product_title text;
  v_quantity      integer;
  v_unit_price    numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_line_total    numeric(12, 2);
  v_subtotal      numeric(12, 2) := 0;
  v_total         numeric(12, 2);
  v_may_override  boolean;
  v_movements     jsonb := '[]'::jsonb;
  v_before        jsonb;
  v_after         jsonb := '{}'::jsonb;
  v_key           text;
  v_delta         integer;
begin
  if not (public.is_admin()
          or public.has_permission('orders.edit')
          or public.is_service_request()) then
    raise exception 'Not allowed to edit an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Unknown order %', p_order_id using errcode = 'no_data_found';
  end if;

  perform public.assert_order_money_editable(v_order);

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item. Cancel it instead.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_may_override := public.is_admin()
                    or public.has_permission('products.manage')
                    or public.is_service_request();

  -- What the order holds now, per variant, captured before it is rewritten.
  select coalesce(jsonb_object_agg(t.variant_id::text, t.quantity), '{}'::jsonb)
    into v_before
    from (
      select li.variant_id, sum(li.quantity)::integer as quantity
        from public.order_line_items li
       where li.order_id = p_order_id and li.variant_id is not null
       group by li.variant_id
    ) t;

  delete from public.order_line_items where order_id = p_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_variant from public.variants where id = (v_item ->> 'variant_id')::uuid;
    if not found then
      raise exception 'Unknown variant %', v_item ->> 'variant_id'
        using errcode = 'foreign_key_violation';
    end if;

    if not v_variant.is_active then
      raise exception 'Variant % is not active and cannot be sold', v_variant.sku
        using errcode = 'check_violation';
    end if;

    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Quantity for % must be a positive whole number', v_variant.sku
        using errcode = 'invalid_parameter_value';
    end if;

    select title into v_product_title from public.products where id = v_variant.product_id;

    v_unit_price := case
      when v_may_override and (v_item ? 'unit_price_egp')
        then (v_item ->> 'unit_price_egp')::numeric
      else v_variant.price_egp
    end;

    v_line_discount := round(coalesce((v_item ->> 'discount_egp')::numeric, 0), 2);
    v_line_total := round(v_unit_price * v_quantity, 2) - v_line_discount;

    if v_line_total < 0 then
      raise exception 'Line discount for % is larger than the line total', v_variant.sku
        using errcode = 'check_violation';
    end if;

    insert into public.order_line_items (
      order_id, variant_id, sku, title, variant_title,
      quantity, unit_price_egp, discount_egp, total_egp
    )
    values (
      p_order_id, v_variant.id, v_variant.sku, coalesce(v_product_title, v_variant.sku),
      nullif(concat_ws(' / ', v_variant.size, v_variant.color), ''),
      v_quantity, v_unit_price, v_line_discount, v_line_total
    );

    v_subtotal := v_subtotal + v_line_total;

    if v_variant.track_inventory then
      v_after := jsonb_set(
        v_after,
        array[v_variant.id::text],
        to_jsonb(coalesce((v_after ->> v_variant.id::text)::integer, 0) + v_quantity)
      );
    end if;
  end loop;

  -- The difference, in the ledger's direction: stock comes back when the
  -- order shrinks, and goes out again when it grows. Every variant that
  -- appears on either side has to be walked, not just the new ones - a line
  -- removed entirely is exactly the case where stock must return.
  for v_key in
    select jsonb_object_keys(v_before || v_after)
  loop
    v_delta := coalesce((v_before ->> v_key)::integer, 0)
             - coalesce((v_after  ->> v_key)::integer, 0);

    if v_delta <> 0 then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_key::uuid,
        'quantity_delta', v_delta
      );
    end if;
  end loop;

  v_total := round(v_subtotal - v_order.discount_egp, 2);
  if v_total < 0 then
    raise exception 'The order discount is now larger than the order subtotal'
      using errcode = 'check_violation';
  end if;

  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         total_egp    = v_total
   where id = p_order_id
  returning * into v_order;

  if jsonb_array_length(v_movements) > 0 then
    -- 'adjustment', not 'store_sale': this is a correction to a record, and
    -- calling it a sale would double-count the order in every sales figure.
    -- A distinct idempotency key per edit, since an order can be edited more
    -- than once and each correction is its own movement.
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'adjustment'::public.stock_movement_reason,
      p_movements       => v_movements,
      p_reference_type  => 'order',
      p_reference_id    => p_order_id::text,
      p_note            => 'Order ' || v_order.order_number || ' edited',
      p_idempotency_key => 'order-edit:' || p_order_id::text || ':' || clock_timestamp()::text
    );
  end if;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    p_order_id, 'items_edited', null,
    jsonb_build_object('subtotal_egp', v_subtotal, 'movements', v_movements),
    auth.uid()
  );

  return v_order;
end;
$function$;

-- create_store_sale
CREATE OR REPLACE FUNCTION public.create_store_sale(p_location_id uuid, p_payment_method payment_method, p_items jsonb, p_idempotency_key text, p_customer_id uuid DEFAULT NULL::uuid, p_discount_egp numeric DEFAULT 0, p_note text DEFAULT NULL::text, p_channel sales_channel DEFAULT 'store'::sales_channel, p_shipping_egp numeric DEFAULT 0)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order         public.orders;
  v_item          jsonb;
  v_variant       public.variants;
  v_product_title text;
  v_quantity      integer;
  v_unit_price    numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_line_total    numeric(12, 2);
  v_subtotal      numeric(12, 2) := 0;
  v_total         numeric(12, 2);
  v_shipping      numeric(12, 2);
    v_may_override  boolean;
  v_movements     jsonb := '[]'::jsonb;
  v_fulfillment   public.fulfillment_status;
  v_payment       public.payment_status;
begin
  perform public.assert_can_move_stock(
    case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
         else 'store_sale'::public.stock_movement_reason end
  );

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item'
      using errcode = 'invalid_parameter_value';
  end if;

  v_shipping := round(coalesce(p_shipping_egp, 0), 2);
  if v_shipping < 0 then
    raise exception 'Shipping cannot be negative'
      using errcode = 'invalid_parameter_value';
  end if;

  v_may_override := public.is_admin()
                    or public.has_permission('products.manage')
                    or public.is_service_request();

  -- Where the goods are.
  --
  -- A counter sale is handed over as it is rung up, so it is born delivered.
  -- Anything else has to be confirmed by phone, packed and shipped, so it
  -- starts at the front of the packing queue like an order from the website.
  -- The cast is explicit: a CASE returning string literals into an enum
  -- column is a mistake this project has made three times.
  v_fulfillment := case
    when p_channel = 'store' then 'delivered'
    else 'awaiting_confirmation'
  end::public.fulfillment_status;

  -- Where the money is, which moves on its own timeline.
  --
  -- Cash on delivery is collected by the courier and only becomes paid when
  -- the settlement containing it is reviewed - see DECISIONS.md. Paying later
  -- is a tab: the goods leave, the money is owed, and someone marks it paid
  -- when the customer settles. Everything else is money already taken.
  v_payment := case
    when p_payment_method in ('cod', 'deferred') then 'pending'
    else 'paid'
  end::public.payment_status;

  insert into public.orders (
    order_number, channel, fulfillment_status, payment_status, location_id,
    customer_id, staff_id, payment_method, note, idempotency_key, shipping_egp
  )
  values (
    public.next_order_number(p_channel), p_channel, v_fulfillment, v_payment, p_location_id,
    p_customer_id, auth.uid(), p_payment_method, p_note, p_idempotency_key, v_shipping
  )
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_variant
      from public.variants
     where id = (v_item ->> 'variant_id')::uuid;

    if not found then
      raise exception 'Unknown variant %', v_item ->> 'variant_id'
        using errcode = 'foreign_key_violation';
    end if;

    if not v_variant.is_active then
      raise exception 'Variant % (%) is not active and cannot be sold',
        v_variant.sku, v_variant.id
        using errcode = 'check_violation';
    end if;

    select title into v_product_title from public.products where id = v_variant.product_id;

    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Quantity for % must be a positive whole number', v_variant.sku
        using errcode = 'invalid_parameter_value';
    end if;

    v_unit_price := case
      when v_may_override and (v_item ? 'unit_price_egp')
        then (v_item ->> 'unit_price_egp')::numeric
      else v_variant.price_egp
    end;

    v_line_discount := round(coalesce((v_item ->> 'discount_egp')::numeric, 0), 2);
    v_line_total := round(v_unit_price * v_quantity, 2) - v_line_discount;

    if v_line_total < 0 then
      raise exception 'Line discount for % is larger than the line total', v_variant.sku
        using errcode = 'check_violation';
    end if;

    insert into public.order_line_items (
      order_id, variant_id, sku, title, variant_title,
      quantity, unit_price_egp, discount_egp, total_egp
    )
    values (
      v_order.id, v_variant.id, v_variant.sku, coalesce(v_product_title, v_variant.sku),
      nullif(concat_ws(' / ', v_variant.size, v_variant.color), ''),
      v_quantity, v_unit_price, v_line_discount, v_line_total
    );

    v_subtotal := v_subtotal + v_line_total;

    if v_variant.track_inventory then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant.id,
        'quantity_delta', -v_quantity
      );
    end if;
  end loop;

  v_total := round(v_subtotal - round(coalesce(p_discount_egp, 0), 2), 2);
  if v_total < 0 then
    raise exception 'Order discount is larger than the order subtotal'
      using errcode = 'check_violation';
  end if;

  -- total_egp is the goods, after discount, WITHOUT shipping. The customer
  -- pays total_egp + shipping_egp; see calculateInvoiceTotals in shared.
  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         discount_egp = round(coalesce(p_discount_egp, 0), 2),
         total_egp    = v_total
   where id = v_order.id
  returning * into v_order;

  -- Stock leaves when the order is taken, on every channel. There is no
  -- reservation concept yet (DECISIONS.md #8), so an order that is later
  -- refused comes back through the returns flow rather than by never having
  -- left. Manual entry is also refused outright when stock is short, unlike
  -- an order arriving from the storefront - the difference is that a person
  -- is standing here and can look.
  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => p_location_id,
      p_reason          => case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
                                else 'store_sale'::public.stock_movement_reason end,
      p_movements       => v_movements,
      p_reference_type  => 'order',
      p_reference_id    => v_order.id::text,
      p_note            => null,
      p_idempotency_key => 'order:' || v_order.id::text
    );
  end if;

  return v_order;
end;
$function$;

-- create_exchange
CREATE OR REPLACE FUNCTION public.create_exchange(p_order_id uuid, p_return_lines jsonb, p_replacement_items jsonb, p_reason return_reason DEFAULT 'wrong_size'::return_reason, p_note text DEFAULT NULL::text)
 RETURNS returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order       public.orders;
  v_return      public.returns;
  v_replacement public.orders;
  v_item        jsonb;
  v_line        record;
begin
  if not ((public.has_permission('orders.edit') and public.has_permission('returns.manage')) or public.is_service_request()) then
    raise exception 'You may not create an exchange' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  insert into public.returns (order_id, type, reason, status, note)
  values (p_order_id, 'exchange', p_reason, 'expected', p_note)
  returning * into v_return;

  for v_item in select * from jsonb_array_elements(p_return_lines)
  loop
    select li.id, li.variant_id, li.sku into v_line
      from public.order_line_items li
     where li.id = (v_item ->> 'order_line_item_id')::uuid
       and li.order_id = p_order_id;

    if not found then
      raise exception 'Line % does not belong to order %',
        v_item ->> 'order_line_item_id', p_order_id
        using errcode = 'foreign_key_violation';
    end if;

    insert into public.return_lines (
      return_id, order_line_item_id, variant_id, sku, quantity_expected
    )
    values (
      v_return.id, v_line.id, v_line.variant_id, v_line.sku,
      (v_item ->> 'quantity')::integer
    );
  end loop;

  -- The replacement is an ordinary order, so it is packed, shipped, tracked
  -- and counted like any other. It carries no money: the customer already paid
  -- for the original.
  v_replacement := public.create_store_sale(
    p_location_id     => v_order.location_id,
    p_payment_method  => coalesce(v_order.payment_method, 'cash'),
    p_items           => p_replacement_items,
    p_idempotency_key => 'exchange:' || v_return.id::text,
    p_customer_id     => v_order.customer_id,
    p_discount_egp    => 0,
    p_note            => 'Exchange for ' || v_order.order_number,
    p_channel         => v_order.channel
  );

  update public.orders
     set fulfillment_status = 'ready_to_pack',
         total_egp          = 0,
         subtotal_egp       = 0,
         payment_status     = 'paid'
   where id = v_replacement.id;

  update public.returns
     set replacement_order_id = v_replacement.id
   where id = v_return.id
  returning * into v_return;

  return v_return;
end;
$function$;

-- ship_order
CREATE OR REPLACE FUNCTION public.ship_order(p_order_id uuid, p_tracking_number text)
 RETURNS shipments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_existing public.shipments;
  v_shipment public.shipments;
  v_tracking text := nullif(trim(p_tracking_number), '');
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not ship orders' using errcode = 'insufficient_privilege';
  end if;

  -- A parcel with no number cannot be chased if it goes missing.
  if v_tracking is null then
    raise exception 'Enter the courier''s shipment number'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null or v_order.fulfillment_status = 'cancelled' then
    raise exception 'Order % is cancelled', v_order.order_number
      using errcode = 'check_violation';
  end if;

  if v_order.fulfillment_status in ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed') then
    -- Same amount the courier collects as before: the goods plus the
    -- shipping the customer agreed to pay. A prepaid order collects nothing.
    insert into public.shipments (
      order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at
    )
    values (
      p_order_id, v_tracking, 'outbound', 'in_transit',
      case when v_order.payment_method = 'cod'
           then v_order.total_egp + v_order.shipping_egp
           else 0 end,
      now()
    )
    returning * into v_shipment;

  elsif v_order.fulfillment_status = 'awaiting_pickup' then
    -- Created the old way and still waiting for the courier: send that
    -- shipment, with the number just entered.
    select * into v_existing
      from public.shipments
     where order_id = p_order_id and direction = 'outbound'
     order by created_at desc
     limit 1
     for update;

    if v_existing.id is null or v_existing.courier = 'own' or v_existing.handed_over_at is not null then
      raise exception 'Order % is already out', v_order.order_number
        using errcode = 'check_violation';
    end if;

    update public.shipments
       set tracking_number = v_tracking,
           status          = 'in_transit',
           handed_over_at  = now()
     where id = v_existing.id
    returning * into v_shipment;

  else
    raise exception 'Order % is already out (it is %)', v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set fulfillment_status = 'in_transit'
   where id = p_order_id;

  return v_shipment;
end;
$function$;

-- start_own_delivery
CREATE OR REPLACE FUNCTION public.start_own_delivery(p_order_id uuid, p_driver_name text)
 RETURNS shipments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_existing public.shipments;
  v_shipment public.shipments;
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not send an order out' using errcode = 'insufficient_privilege';
  end if;

  if nullif(trim(p_driver_name), '') is null then
    raise exception 'Say who is delivering it' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null or v_order.fulfillment_status = 'cancelled' then
    raise exception 'Order % is cancelled', v_order.order_number
      using errcode = 'check_violation';
  end if;

  select * into v_existing
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc
   limit 1
   for update;

  if v_order.fulfillment_status = 'awaiting_pickup'
     and v_existing.id is not null
     and v_existing.courier <> 'own'
     and v_existing.handed_over_at is null then
    -- Created for the courier but never collected: switch it to our driver.
    update public.shipments
       set status = 'cancelled',
           note = coalesce(note || ' ', '') || '[Went with our own driver instead]'
     where id = v_existing.id;
  elsif v_order.fulfillment_status not in ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed') then
    raise exception 'Order % is already out, or the courier already has it', v_order.order_number
      using errcode = 'check_violation';
  end if;

  -- Same amount a courier would collect: the goods plus the shipping the
  -- customer agreed to pay. A prepaid order collects nothing.
  insert into public.shipments (
    order_id, courier, driver_name, direction, status, cod_amount_egp, handed_over_at
  )
  values (
    p_order_id, 'own', trim(p_driver_name), 'outbound', 'out_for_delivery',
    case when v_order.payment_method = 'cod'
         then v_order.total_egp + v_order.shipping_egp
         else 0 end,
    now()
  )
  returning * into v_shipment;

  update public.orders
     set fulfillment_status = 'out_for_delivery'
   where id = p_order_id;

  return v_shipment;
end;
$function$;

-- mark_order_packed
CREATE OR REPLACE FUNCTION public.mark_order_packed(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders;
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not pack orders' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'packed' then
    return v_order;
  end if;

  if v_order.fulfillment_status not in ('confirmed', 'ready_to_pack') then
    raise exception 'Order % is not ready to pack (it is %)',
      v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  update public.orders
     set fulfillment_status = 'packed'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$function$;

-- unpack_order
CREATE OR REPLACE FUNCTION public.unpack_order(p_order_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders;
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not change a packed order' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status <> 'packed' then
    raise exception 'Only a packed order can be put back (this one is %)',
      v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  update public.orders
     set fulfillment_status = 'ready_to_pack',
         note = case
                  when p_reason is null then note
                  else coalesce(note || E'\n', '') || p_reason
                end
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$function$;

-- record_shipment
CREATE OR REPLACE FUNCTION public.record_shipment(p_order_id uuid, p_tracking_number text, p_cod_amount_egp numeric DEFAULT NULL::numeric, p_service_type text DEFAULT NULL::text, p_zone text DEFAULT NULL::text, p_subzone text DEFAULT NULL::text)
 RETURNS shipments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_shipment public.shipments;
  v_cod      numeric(12, 2);
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not create a shipment' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'cancelled' then
    raise exception 'Order % is cancelled', v_order.order_number
      using errcode = 'check_violation';
  end if;

  -- COD collects the goods plus the shipping the customer agreed to pay.
  -- A prepaid order collects nothing.
  v_cod := coalesce(
    p_cod_amount_egp,
    case when v_order.payment_method = 'cod'
         then v_order.total_egp + v_order.shipping_egp
         else 0 end
  );

  insert into public.shipments (
    order_id, tracking_number, direction, status,
    cod_amount_egp, service_type, zone, subzone
  )
  values (
    p_order_id, nullif(trim(p_tracking_number), ''), 'outbound', 'awaiting_pickup',
    v_cod, p_service_type, p_zone, p_subzone
  )
  returning * into v_shipment;

  update public.orders
     set fulfillment_status = 'awaiting_pickup'
   where id = p_order_id;

  return v_shipment;
end;
$function$;

-- mark_shipment_handed_over
CREATE OR REPLACE FUNCTION public.mark_shipment_handed_over(p_shipment_id uuid)
 RETURNS shipments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment public.shipments;
begin
  if not (public.has_permission('orders.ship') or public.is_service_request()) then
    raise exception 'You may not hand over a shipment' using errcode = 'insufficient_privilege';
  end if;

  update public.shipments
     set status = 'in_transit',
         handed_over_at = coalesce(handed_over_at, now())
   where id = p_shipment_id
  returning * into v_shipment;

  if not found then
    raise exception 'Shipment % not found', p_shipment_id using errcode = 'no_data_found';
  end if;

  if v_shipment.tracking_number is null then
    raise exception 'Shipment % has no tracking number. Record the courier code before handing it over.',
      p_shipment_id
      using errcode = 'check_violation',
            hint = 'A parcel with no tracking number cannot be chased if it goes missing.';
  end if;

  update public.orders set fulfillment_status = 'in_transit' where id = v_shipment.order_id;

  return v_shipment;
end;
$function$;

-- receive_return
CREATE OR REPLACE FUNCTION public.receive_return(p_return_id uuid, p_lines jsonb, p_note text DEFAULT NULL::text)
 RETURNS returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_return     public.returns;
  v_order      public.orders;
  v_item       jsonb;
  v_line       public.return_lines;
  v_resellable integer;
  v_damaged    integer;
  v_delta      integer;
  v_movements  jsonb := '[]'::jsonb;
  v_missing    integer := 0;
  v_total_back integer := 0;
begin
  if not (public.has_permission('returns.manage') or public.is_service_request()) then
    raise exception 'You may not check in a return' using errcode = 'insufficient_privilege';
  end if;

  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'Return % not found', p_return_id using errcode = 'no_data_found';
  end if;

  -- Closed means somebody decided it was finished, shortfall and all.
  if v_return.status = 'closed' then
    return v_return;
  end if;

  select * into v_order from public.orders where id = v_return.order_id;

  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_line
      from public.return_lines
     where id = (v_item ->> 'return_line_id')::uuid
       and return_id = p_return_id;

    if not found then
      raise exception 'Return line % does not belong to return %',
        v_item ->> 'return_line_id', p_return_id
        using errcode = 'foreign_key_violation';
    end if;

    v_resellable := coalesce((v_item ->> 'quantity_resellable')::integer, 0);
    v_damaged    := coalesce((v_item ->> 'quantity_damaged')::integer, 0);

    -- Only the change since last time. This is what makes a second check-in
    -- safe rather than a way to invent stock.
    v_delta := v_resellable - v_line.quantity_resellable;

    update public.return_lines
       set quantity_received   = v_resellable + v_damaged,
           quantity_resellable = v_resellable,
           quantity_damaged    = v_damaged,
           condition_note      = coalesce(v_item ->> 'condition_note', condition_note)
     where id = v_line.id;

    if v_delta <> 0 then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_line.variant_id,
        'quantity_delta', v_delta
      );
    end if;
  end loop;

  select coalesce(sum(quantity_missing), 0), coalesce(sum(quantity_resellable), 0)
    into v_missing, v_total_back
    from public.return_lines where return_id = p_return_id;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'return',
      p_movements       => v_movements,
      p_reference_type  => 'return',
      p_reference_id    => p_return_id::text,
      p_note            => p_note,
      -- Keyed on the running total rather than the return alone, so a
      -- double-tapped confirm does nothing while a genuine correction applies.
      p_idempotency_key => 'return:' || p_return_id::text || ':' || v_total_back::text
    );
  end if;

  update public.returns
     set status      = case when v_missing > 0 then 'discrepancy'::public.return_status
                            else 'received'::public.return_status end,
         received_at = coalesce(received_at, now()),
         received_by = coalesce(received_by, auth.uid()),
         note        = coalesce(p_note, note)
   where id = p_return_id
  returning * into v_return;

  update public.orders
     set fulfillment_status = 'returned'
   where id = v_return.order_id
     and fulfillment_status <> 'returned';

  if v_return.outbound_shipment_id is not null then
    update public.shipments
       set status = 'returned', returned_at = coalesce(returned_at, now())
     where id = v_return.outbound_shipment_id;
  end if;

  return v_return;
end;
$function$;

-- record_delivery_failure
CREATE OR REPLACE FUNCTION public.record_delivery_failure(p_order_id uuid, p_reason return_reason, p_note text DEFAULT NULL::text)
 RETURNS returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_return   public.returns;
  v_shipment public.shipments;
  v_line     record;
begin
  if not (public.has_permission('returns.manage') or public.is_service_request()) then
    raise exception 'You may not record a delivery failure' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if exists (select 1 from public.returns where order_id = p_order_id and status <> 'closed') then
    raise exception 'Order % already has an open return', v_order.order_number
      using errcode = 'unique_violation';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc limit 1;

  insert into public.returns (
    order_id, outbound_shipment_id, type, reason, status, courier_reported_at, note
  )
  values (
    p_order_id, v_shipment.id, 'failed_delivery', p_reason, 'expected', now(), p_note
  )
  returning * into v_return;

  -- Everything that went out is expected back. If only part of it comes, the
  -- shortfall shows up at check-in rather than being silently forgotten.
  for v_line in
    select id, variant_id, sku, quantity from public.order_line_items where order_id = p_order_id
  loop
    insert into public.return_lines (
      return_id, order_line_item_id, variant_id, sku, quantity_expected
    )
    values (v_return.id, v_line.id, v_line.variant_id, v_line.sku, v_line.quantity);
  end loop;

  if v_shipment.id is not null then
    update public.shipments
       set status = 'return_in_transit', failed_at = now()
     where id = v_shipment.id;
  end if;

  -- Still with the courier. No stock moves here - the goods are in a van.
  update public.orders set fulfillment_status = 'return_in_transit' where id = p_order_id;

  return v_return;
end;
$function$;

-- start_post_delivery_return
CREATE OR REPLACE FUNCTION public.start_post_delivery_return(p_order_id uuid, p_reason return_reason, p_note text DEFAULT NULL::text)
 RETURNS returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_shipment public.shipments;
  v_return   public.returns;
  v_line     record;
begin
  if not (public.has_permission('returns.manage') or public.is_service_request()) then
    raise exception 'You may not record a return' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status <> 'delivered' then
    raise exception 'Order % was never delivered, so there is nothing to return',
      v_order.order_number using errcode = 'invalid_parameter_value';
  end if;

  if exists (select 1 from public.returns where order_id = p_order_id and status <> 'closed') then
    raise exception 'Order % already has an open return', v_order.order_number
      using errcode = 'unique_violation';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc limit 1;

  insert into public.returns (
    order_id, outbound_shipment_id, type, reason, status, note
  )
  values (
    p_order_id, v_shipment.id, 'post_delivery', p_reason, 'expected', p_note
  )
  returning * into v_return;

  -- Everything that went out is expected back, same as record_delivery_failure -
  -- a shortfall shows up at check-in rather than being silently forgotten.
  for v_line in
    select id, variant_id, sku, quantity from public.order_line_items where order_id = p_order_id
  loop
    insert into public.return_lines (
      return_id, order_line_item_id, variant_id, sku, quantity_expected
    )
    values (v_return.id, v_line.id, v_line.variant_id, v_line.sku, v_line.quantity);
  end loop;

  return v_return;
end;
$function$;

-- lookup_return_by_order_number
CREATE OR REPLACE FUNCTION public.lookup_return_by_order_number(p_order_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_customer public.customers;
  v_shipment public.shipments;
  v_return   public.returns;
  v_lines    jsonb;
begin
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order
    from public.orders
   where upper(trim(order_number)) in (
           upper(trim(p_order_number)),
           '#' || upper(trim(p_order_number))
         );

  if v_order.id is null then
    return jsonb_build_object('state', 'not_found', 'order_number', trim(p_order_number));
  end if;

  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Carried through for the receipt line and for a courier-shipped order
  -- that also happens to have a code, so the screen is not blank for it.
  select * into v_shipment
    from public.shipments
   where order_id = v_order.id and direction = 'outbound'
   order by created_at desc
   limit 1;

  select * into v_return
    from public.returns
   where order_id = v_order.id
   order by created_at desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'return_line_id', rl.id,
           'sku', rl.sku,
           'variant_id', rl.variant_id,
           'title', li.title,
           'variant_title', li.variant_title,
           'quantity_expected', rl.quantity_expected,
           'quantity_received', rl.quantity_received,
           'quantity_resellable', rl.quantity_resellable,
           'quantity_damaged', rl.quantity_damaged
         ) order by rl.created_at), '[]'::jsonb)
    into v_lines
    from public.return_lines rl
    left join public.order_line_items li on li.id = rl.order_line_item_id
   where rl.return_id = v_return.id;

  return jsonb_build_object(
    'state', case
      when v_return.id is not null and v_return.status in ('received', 'closed')
        then 'already_received'
      when v_return.id is not null then 'ready_to_receive'
      -- Handed to the customer already - whether that was over the counter
      -- or, someday, a courier delivery this system can recognise as such.
      when v_order.fulfillment_status = 'delivered'
        then 'needs_post_delivery_record'
      when v_order.fulfillment_status in ('in_transit', 'out_for_delivery',
                                          'delivery_failed', 'return_in_transit')
        then 'needs_failure_record'
      else 'not_returnable'
    end,
    'tracking_number', v_shipment.tracking_number,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'fulfillment_status', v_order.fulfillment_status,
      'payment_method', v_order.payment_method,
      'total_egp', v_order.total_egp,
      'customer_name', v_customer.full_name,
      'customer_phone', v_customer.phone,
      'governorate', v_customer.governorate
    ),
    'return', case
      when v_return.id is null then null
      else jsonb_build_object(
        'id', v_return.id,
        'type', v_return.type,
        'reason', v_return.reason,
        'status', v_return.status
      )
    end,
    'lines', v_lines,
    'order_lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'order_line_item_id', li.id,
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       where li.order_id = v_order.id
    )
  );
end;
$function$;

-- lookup_return_by_tracking
CREATE OR REPLACE FUNCTION public.lookup_return_by_tracking(p_tracking text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_return   public.returns;
  v_customer public.customers;
  v_lines    jsonb;
begin
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('state', 'not_found', 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  select * into v_return
    from public.returns
   where outbound_shipment_id = v_shipment.id
   order by created_at desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'return_line_id', rl.id,
           'sku', rl.sku,
           'variant_id', rl.variant_id,
           'title', li.title,
           'variant_title', li.variant_title,
           'quantity_expected', rl.quantity_expected,
           'quantity_received', rl.quantity_received,
           'quantity_resellable', rl.quantity_resellable,
           'quantity_damaged', rl.quantity_damaged
         ) order by rl.created_at), '[]'::jsonb)
    into v_lines
    from public.return_lines rl
    left join public.order_line_items li on li.id = rl.order_line_item_id
   where rl.return_id = v_return.id;

  return jsonb_build_object(
    'state', case
      -- Fully accounted for. Scanning it again says so rather than inviting a
      -- second count of the same parcel.
      when v_return.id is not null and v_return.status in ('received', 'closed')
        then 'already_received'
      -- A return still marked short stays open on purpose: the missing piece
      -- may turn up next week, and it should be recordable when it does.
      -- receive_return only ever moves the difference, so scanning a short
      -- parcel again cannot add the same garments to stock twice.
      when v_return.id is not null then 'ready_to_receive'
      -- The parcel is on the table but nobody recorded the failure when the
      -- courier rang. Rather than making someone go and do that first, the
      -- screen offers to record it and check it in as one action.
      when v_order.fulfillment_status in ('in_transit', 'out_for_delivery',
                                          'delivery_failed', 'return_in_transit')
        then 'needs_failure_record'
      else 'not_returnable'
    end,
    'tracking_number', v_shipment.tracking_number,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'fulfillment_status', v_order.fulfillment_status,
      'payment_method', v_order.payment_method,
      'total_egp', v_order.total_egp,
      'customer_name', v_customer.full_name,
      'customer_phone', v_customer.phone,
      'governorate', v_customer.governorate
    ),
    'return', case
      when v_return.id is null then null
      else jsonb_build_object(
        'id', v_return.id,
        'type', v_return.type,
        'reason', v_return.reason,
        'status', v_return.status
      )
    end,
    'lines', v_lines,
    -- What went out, for the case where no return exists yet and the screen
    -- has to show the packer what to expect in the parcel.
    'order_lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'order_line_item_id', li.id,
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       where li.order_id = v_order.id
    )
  );
end;
$function$;

-- record_confirmation_call
CREATE OR REPLACE FUNCTION public.record_confirmation_call(p_order_id uuid, p_outcome confirmation_outcome, p_note text DEFAULT NULL::text, p_hold_until date DEFAULT NULL::date)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders;
begin
  -- Anyone in the office makes these calls, so this is open to every active
  -- staff member rather than to one role.
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status not in ('awaiting_confirmation', 'confirmed') then
    raise exception 'Order % has moved past confirmation (it is %)',
      v_order.order_number, v_order.fulfillment_status
      using errcode = 'check_violation';
  end if;

  -- The customer does not want it after all. Cancelling here rather than
  -- shipping and having it refused is the entire point of ringing first: it
  -- saves a courier run out and another one back.
  if p_outcome = 'cancelled_by_customer' then
    update public.orders
       set confirmation_outcome  = p_outcome,
           confirmation_attempts = confirmation_attempts + 1
     where id = p_order_id;

    return public.cancel_order(
      p_order_id,
      coalesce(p_note, 'Customer cancelled on the confirmation call')
    );
  end if;

  update public.orders
     set confirmation_outcome  = p_outcome,
         confirmation_attempts = confirmation_attempts + 1,
         confirmed_at          = case when p_outcome = 'confirmed' then now() else confirmed_at end,
         confirmed_by          = case when p_outcome = 'confirmed' then auth.uid() else confirmed_by end,
         -- Asked to receive it later. Drops out of the queue until that date
         -- rather than sitting there looking neglected.
         hold_until            = case
                                   when p_outcome = 'asked_to_delay' then p_hold_until
                                   else hold_until
                                 end,
         fulfillment_status    = case
                                   when p_outcome = 'confirmed'
                                     then 'ready_to_pack'::public.fulfillment_status
                                   else fulfillment_status
                                 end,
         note                  = case
                                   when p_note is null then note
                                   else coalesce(note || E'\n', '') || p_note
                                 end
   where id = p_order_id
  returning * into v_order;

  -- Unreachable is not a failure on the first try; it is a failure on the
  -- fourth. Recording the attempt is what makes that visible.
  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    p_order_id, 'confirmation_call', p_note,
    jsonb_build_object('outcome', p_outcome, 'attempt', v_order.confirmation_attempts),
    auth.uid()
  );

  return v_order;
end;
$function$;

-- resolve_sync_issue
CREATE OR REPLACE FUNCTION public.resolve_sync_issue(p_issue_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS sync_issues
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_issue public.sync_issues;
  v_delta integer;
begin
  if not (public.is_admin() or public.has_permission('sync.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may resolve a sync issue'
      using errcode = 'insufficient_privilege';
  end if;

  if p_action not in ('trust_crm', 'trust_shopify', 'ignore') then
    raise exception 'Unknown action %. Use trust_crm, trust_shopify or ignore', p_action
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_issue from public.sync_issues where id = p_issue_id for update;
  if not found then
    raise exception 'Sync issue % not found', p_issue_id using errcode = 'no_data_found';
  end if;

  -- Already settled - by someone else a moment ago, or by a second tap. The
  -- correction must not be applied twice.
  if v_issue.status <> 'open' then
    return v_issue;
  end if;

  if p_action = 'trust_shopify' then
    -- The person has decided Shopify's count is the real one. We do not edit
    -- the ledger; we append an adjustment that says so, signed by them.
    if v_issue.variant_id is null or v_issue.location_id is null then
      raise exception 'This issue has no variant to adjust'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_issue.shopify_quantity is null or v_issue.crm_quantity is null then
      raise exception 'Shopify gave no number for this item, so there is nothing to accept'
        using errcode = 'invalid_parameter_value';
    end if;

    v_delta := v_issue.shopify_quantity - v_issue.crm_quantity;

    if v_delta <> 0 then
      perform public.record_stock_movements(
        p_location_id    => v_issue.location_id,
        p_reason         => 'adjustment',
        p_movements      => jsonb_build_array(jsonb_build_object(
                              'variant_id', v_issue.variant_id,
                              'quantity_delta', v_delta
                            )),
        p_reference_type => 'sync_issue',
        p_reference_id   => v_issue.id::text,
        p_note           => coalesce(p_note, 'Accepted the Shopify count at reconciliation')
      );
    end if;

  elsif p_action = 'trust_crm'
        and v_issue.variant_id is not null
        and v_issue.location_id is not null then
    -- Our number stands, so Shopify is told it again.
    insert into public.sync_outbox (variant_id, location_id, dirty_since, next_try_at)
    values (v_issue.variant_id, v_issue.location_id, now(), now())
    on conflict (variant_id, location_id) do update
      set dirty_since = least(public.sync_outbox.dirty_since, now()),
          next_try_at = least(public.sync_outbox.next_try_at, now());
  end if;

  update public.sync_issues
     set status = case
                    when p_action = 'ignore' then 'ignored'::public.sync_issue_status
                    else 'resolved'::public.sync_issue_status
                  end,
         resolved_at = now(),
         resolved_by = auth.uid(),
         resolution_note = coalesce(p_note, p_action)
   where id = p_issue_id
  returning * into v_issue;

  return v_issue;
end;
$function$;

-- resolve_sync_issues
CREATE OR REPLACE FUNCTION public.resolve_sync_issues(p_issue_ids uuid[], p_action text, p_note text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id      uuid;
  v_settled integer := 0;
begin
  if not (public.is_admin() or public.has_permission('sync.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may resolve a sync issue'
      using errcode = 'insufficient_privilege';
  end if;

  -- One transaction: if any of them fails, none of them is applied, so a
  -- product is never left half corrected.
  for v_id in
    select distinct si.id
      from public.sync_issues si
     where si.id = any (coalesce(p_issue_ids, '{}'))
       and si.status = 'open'
  loop
    perform public.resolve_sync_issue(v_id, p_action, p_note);
    v_settled := v_settled + 1;
  end loop;

  return v_settled;
end;
$function$;

-- close_linked_unmapped_issues
CREATE OR REPLACE FUNCTION public.close_linked_unmapped_issues()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_closed integer;
begin
  if not (public.is_service_request()
          or public.is_admin()
          or public.has_permission('sync.manage')) then
    raise exception 'Not allowed to close sync issues'
      using errcode = 'insufficient_privilege';
  end if;

  update public.sync_issues si
     set status          = 'resolved',
         resolved_at     = now(),
         resolution_note = 'Linked to a CRM variant by a later import'
   where si.status = 'open'
     and si.type = 'unmapped_inventory_item'
     and exists (
       select 1
         from public.variants v
        where v.shopify_inventory_item_id = (si.details ->> 'inventory_item_id')::bigint
     );

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$function$;

