-- ---------------------------------------------------------------------------
-- The owner, reopening a payment recorded by mistake, and one sync issue
-- per product.
--
-- A paid order's money is locked (20260921200000_edit_orders.sql): counted
-- money must not be quietly rewritten. But a till mistake - "cash" picked for
-- an order nobody has paid yet - then has no way back, and the order claims
-- money that never arrived. The fix is deliberately narrow: one person, the
-- owner, can set a paid order back to unpaid and correct its payment method,
-- with a reason that goes into the order's history under their name. After
-- that the order's money is open again and the ordinary editor applies.
-- An order on a courier statement stays locked even for the owner: that
-- money was counted against Accurate's paper, and undoing it here would make
-- the statement disagree with the orders it settled.
--
-- "Owner" is not a role. Roles decide what a person's job lets them do, and
-- several people are admin. The owner mark is on one account, and nobody can
-- set it from the app - not even an admin, not even the owner. It is set in
-- this migration and changeable only in the database.
-- ---------------------------------------------------------------------------

alter table public.staff add column is_owner boolean not null default false;

comment on column public.staff.is_owner is
  'The business owner. Unlocks reopening a paid order. Settable only in the '
  'database - the guard trigger refuses it from any signed-in user.';

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select s.is_owner from public.staff s where s.id = auth.uid() and s.is_active),
    false
  );
$$;

revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- --- Nobody grants themselves the owner mark, or takes it away -------------
--
-- Separate from staff_guard_privileged_columns, which lets any admin change
-- roles and activation: this must hold against admins too. And because
-- several people are admin, another admin could otherwise demote or
-- deactivate the owner's account from the staff screen and lock them out of
-- this. Only the owner changes the owner's own role or activation.

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
       and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
      raise exception 'Only the owner can change the owner''s own role or access'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger staff_guard_owner_trg
  before insert or update on public.staff
  for each row execute function public.staff_guard_owner();

update public.staff
   set is_owner = true
 where id = (select id from auth.users where email = 'yassen@duch.store');

-- --- Reopening a payment -----------------------------------------------------

create or replace function public.reopen_order_payment(
  p_order_id       uuid,
  p_payment_method public.payment_method,
  p_reason         text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders;
  v_method public.payment_method;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can reopen a paid order'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'Say why this payment is being reopened'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Unknown order %', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'Order % was cancelled', v_order.order_number
      using errcode = 'check_violation', hint = 'order_cancelled';
  end if;

  if v_order.payment_status <> 'paid' then
    raise exception 'Order % is not marked paid, so there is nothing to reopen', v_order.order_number
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.settlement_lines where order_id = p_order_id) then
    raise exception
      'Order % is on a courier statement and its money was counted against it.',
      v_order.order_number
      using errcode = 'restrict_violation', hint = 'order_on_settlement';
  end if;

  v_method := coalesce(p_payment_method, v_order.payment_method);

  -- The status trigger logs the change of payment status under the owner's
  -- name. This row carries what that one cannot: why, and the method before
  -- and after.
  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    p_order_id, 'payment_reopened', trim(p_reason),
    jsonb_build_object('from_method', v_order.payment_method, 'to_method', v_method),
    auth.uid()
  );

  update public.orders
     set payment_status = 'pending',
         payment_method = v_method
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.reopen_order_payment is
  'Owner only. Sets a paid order back to unpaid and corrects its payment '
  'method, with a reason in the order history. Not for an order on a courier '
  'statement.';

revoke execute on function public.reopen_order_payment(uuid, public.payment_method, text) from public, anon, authenticated;
grant execute on function public.reopen_order_payment(uuid, public.payment_method, text) to authenticated;

-- --- One open issue per product, not one for all of them -------------------
--
-- Product-level issues have no variant, so the old match - type, variant,
-- location - treated every one of them as the same issue and overwrote its
-- details with the latest product. A "no SKU" issue for one product became
-- another product's on go-live week, and the first product disappeared from
-- the screen. Where there is no variant, the Shopify product or inventory
-- item named in the details is part of what makes an issue the same one.

create or replace function public.open_sync_issue(
  p_type             public.sync_issue_type,
  p_variant_id       uuid,
  p_location_id      uuid,
  p_crm_quantity     integer,
  p_shopify_quantity integer,
  p_details          jsonb default '{}'::jsonb,
  p_detected_by      text default 'nightly_reconcile'
)
returns public.sync_issues
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.sync_issues;
begin
  -- Update-then-insert rather than ON CONFLICT, because variant_id and
  -- location_id are nullable on an unmapped-item issue and SQL treats two
  -- NULLs as different values - a unique index would not catch the repeat.
  update public.sync_issues
     set last_seen_at     = now(),
         occurrences      = occurrences + 1,
         crm_quantity     = p_crm_quantity,
         shopify_quantity = p_shopify_quantity,
         details          = coalesce(p_details, '{}'::jsonb)
   where status = 'open'
     and type = p_type
     and variant_id is not distinct from p_variant_id
     and location_id is not distinct from p_location_id
     and (
       p_variant_id is not null
       or (
         details ->> 'shopify_product_id' is not distinct from p_details ->> 'shopify_product_id'
         and details ->> 'inventory_item_id' is not distinct from p_details ->> 'inventory_item_id'
       )
     )
  returning * into v_issue;

  if found then
    return v_issue;
  end if;

  insert into public.sync_issues (
    type, variant_id, location_id, crm_quantity, shopify_quantity,
    details, detected_by
  )
  values (
    p_type, p_variant_id, p_location_id, p_crm_quantity, p_shopify_quantity,
    coalesce(p_details, '{}'::jsonb), p_detected_by
  )
  returning * into v_issue;

  return v_issue;
end;
$$;
