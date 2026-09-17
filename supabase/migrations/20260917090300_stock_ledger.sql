-- ---------------------------------------------------------------------------
-- Phase 2: the stock ledger.
--
-- Two tables, and the relationship between them is the whole design:
--
--   stock_movements  the truth. Append-only. Every change stock has ever made,
--                    with who did it and why. Nothing ever updates or deletes
--                    a row here - a mistake is corrected by appending the
--                    opposite movement, so the history stays honest.
--
--   stock_levels     a running total, maintained by a trigger. It is NOT a
--                    second source of truth; a test asserts it always equals
--                    the sum of the ledger. It exists for two reasons:
--                    (1) summing a ledger that grows forever would get slower
--                        every month,
--                    (2) it gives us a single row to lock, which is what stops
--                        two cashiers selling the same last hoodie at the same
--                        moment. Without a row to lock, both would read "1 in
--                        stock", both would insert, and we would owe a
--                        customer a hoodie that does not exist.
-- ---------------------------------------------------------------------------

create type public.stock_movement_reason as enum (
  'online_order',
  'store_sale',
  'wholesale',
  'production_in',
  'return',
  'cancellation',
  'adjustment',
  'initial_import'
);

create table public.stock_movements (
  id               uuid primary key default gen_random_uuid(),
  variant_id       uuid not null references public.variants (id) on delete restrict,
  location_id      uuid not null references public.locations (id) on delete restrict,
  quantity_delta   integer not null check (quantity_delta <> 0),
  reason           public.stock_movement_reason not null,
  reference_type   text,
  reference_id     text,
  note             text,
  staff_id         uuid references public.staff (id) on delete set null,
  idempotency_key  text unique,
  created_at       timestamptz not null default now()
);

comment on table public.stock_movements is
  'Append-only ledger. The single source of truth for inventory.';
comment on column public.stock_movements.quantity_delta is
  'Signed change. Negative for sales, positive for production and returns.';
comment on column public.stock_movements.staff_id is
  'Null when the movement came from a webhook or scheduled job rather than a person.';
comment on column public.stock_movements.idempotency_key is
  'Set by callers that may retry - a replayed webhook or a double-tapped '
  'confirm button hits the unique constraint instead of moving stock twice.';

create index stock_movements_variant_location_idx
  on public.stock_movements (variant_id, location_id, created_at desc);
create index stock_movements_created_at_idx on public.stock_movements (created_at desc);
create index stock_movements_reason_idx on public.stock_movements (reason, created_at desc);
create index stock_movements_reference_idx
  on public.stock_movements (reference_type, reference_id)
  where reference_id is not null;

-- --- Append-only, enforced ------------------------------------------------
--
-- RLS grants nobody update or delete. These triggers are the belt to that
-- pair of braces: they also stop the service role key, a migration, or a
-- careless psql session from quietly editing history.

create or replace function public.stock_movements_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'stock_movements is append-only; % is not permitted. Append a correcting movement instead.',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger stock_movements_no_update
  before update on public.stock_movements
  for each row execute function public.stock_movements_block_mutation();

create trigger stock_movements_no_delete
  before delete on public.stock_movements
  for each row execute function public.stock_movements_block_mutation();

-- --- The running total -----------------------------------------------------

create table public.stock_levels (
  variant_id               uuid not null references public.variants (id) on delete cascade,
  location_id              uuid not null references public.locations (id) on delete cascade,
  quantity                 integer not null default 0,
  updated_at               timestamptz not null default now(),
  -- What we last told Shopify, and when. Half of the echo detection: an
  -- inventory webhook carrying exactly this number, arriving shortly after we
  -- sent it, is our own push coming back to us.
  shopify_pushed_quantity  integer,
  shopify_pushed_at        timestamptz,
  primary key (variant_id, location_id)
);

comment on table public.stock_levels is
  'Derived running total of stock_movements. Never written directly - only by '
  'the apply trigger. verify_stock_levels() proves it matches the ledger.';

create index stock_levels_location_idx on public.stock_levels (location_id);
create index stock_levels_low_idx on public.stock_levels (quantity) where quantity <= 5;

-- --- Applying a movement ---------------------------------------------------

create or replace function public.stock_movements_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quantity integer;
begin
  -- The ON CONFLICT DO UPDATE takes a row-level lock. A second transaction
  -- inserting a movement for the same variant and location blocks here until
  -- the first commits, then sees the first transaction's result. This is the
  -- mechanism that makes concurrent sales safe.
  insert into public.stock_levels as sl (variant_id, location_id, quantity, updated_at)
  values (new.variant_id, new.location_id, new.quantity_delta, now())
  on conflict (variant_id, location_id) do update
    set quantity   = sl.quantity + excluded.quantity,
        updated_at = now()
  returning sl.quantity into v_quantity;

  -- Reasons where the CRM is the gatekeeper: we are being asked to approve a
  -- sale, so we refuse to approve one we cannot supply.
  --
  -- Reasons NOT listed here (online_order, return, cancellation, adjustment,
  -- production_in, initial_import) record something that already happened
  -- somewhere else. Rejecting those would mean throwing away the record and
  -- leaving the ledger less accurate, not more - so they are allowed through
  -- and the resulting negative is surfaced as a sync issue instead.
  if v_quantity < 0 and new.reason in ('store_sale', 'wholesale') then
    raise exception 'insufficient_stock: variant % at location % would go to %',
      new.variant_id, new.location_id, v_quantity
      using errcode = 'check_violation',
            hint = 'insufficient_stock';
  end if;

  return new;
end;
$$;

create trigger stock_movements_apply_trg
  after insert on public.stock_movements
  for each row execute function public.stock_movements_apply();

-- --- Proving the cache is honest -------------------------------------------

create or replace function public.stock_ledger_balance(p_variant_id uuid, p_location_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(quantity_delta), 0)::integer
    from public.stock_movements
   where variant_id = p_variant_id
     and location_id = p_location_id;
$$;

comment on function public.stock_ledger_balance is
  'Sums the ledger from scratch. The slow, definitive answer - used by tests '
  'and the nightly job to check stock_levels has not drifted.';

create or replace function public.verify_stock_levels()
returns table (
  variant_id      uuid,
  location_id     uuid,
  cached_quantity integer,
  ledger_quantity integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ledger as (
    select m.variant_id, m.location_id, sum(m.quantity_delta)::integer as qty
      from public.stock_movements m
     group by m.variant_id, m.location_id
  )
  select
    coalesce(sl.variant_id, l.variant_id),
    coalesce(sl.location_id, l.location_id),
    coalesce(sl.quantity, 0),
    coalesce(l.qty, 0)
  from public.stock_levels sl
  full outer join ledger l
    on l.variant_id = sl.variant_id
   and l.location_id = sl.location_id
  where coalesce(sl.quantity, 0) <> coalesce(l.qty, 0);
$$;

comment on function public.verify_stock_levels is
  'Returns a row for every disagreement between the cache and the ledger. '
  'Should always return zero rows; anything else is a bug worth paging about.';

-- Rebuilds the cache from the ledger. For disaster recovery only - the
-- ordinary path is the apply trigger.
create or replace function public.rebuild_stock_levels()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if not (public.is_admin() or public.is_service_request()) then
    raise exception 'Only an admin may rebuild stock levels'
      using errcode = 'insufficient_privilege';
  end if;

  with ledger as (
    select m.variant_id, m.location_id, sum(m.quantity_delta)::integer as qty
      from public.stock_movements m
     group by m.variant_id, m.location_id
  )
  insert into public.stock_levels as sl (variant_id, location_id, quantity, updated_at)
  select l.variant_id, l.location_id, l.qty, now() from ledger l
  on conflict (variant_id, location_id) do update
    set quantity = excluded.quantity,
        updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- --- Who may move stock, and why -------------------------------------------

create or replace function public.assert_can_move_stock(p_reason public.stock_movement_reason)
returns void
language plpgsql
stable
as $$
declare
  v_role public.staff_role;
begin
  -- Edge Functions and the Worker use the service role key. They carry no end
  -- user, and they are the only callers allowed to record online_order,
  -- cancellation and return movements.
  if public.is_service_request() then
    return;
  end if;

  v_role := public.auth_role();

  if v_role is null then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  if v_role = 'admin' then
    return;
  end if;

  case p_reason
    when 'store_sale' then
      if v_role in ('sales', 'stock_manager') then return; end if;
    when 'adjustment', 'production_in', 'initial_import', 'return', 'wholesale' then
      if v_role = 'stock_manager' then return; end if;
    else
      null;
  end case;

  raise exception 'Role % may not record a % movement', v_role, p_reason
    using errcode = 'insufficient_privilege';
end;
$$;

-- --- The one way to write to the ledger ------------------------------------

create or replace function public.record_stock_movements(
  p_location_id     uuid,
  p_reason          public.stock_movement_reason,
  p_movements       jsonb,
  p_reference_type  text default null,
  p_reference_id    text default null,
  p_note            text default null,
  p_idempotency_key text default null
)
returns setof public.stock_movements
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item      jsonb;
  v_staff_id  uuid := auth.uid();
  v_key       text;
  v_index     integer := 0;
begin
  perform public.assert_can_move_stock(p_reason);

  if jsonb_typeof(p_movements) <> 'array' or jsonb_array_length(p_movements) = 0 then
    raise exception 'p_movements must be a non-empty JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A previously completed call with the same key: return what it produced
  -- rather than doing the work twice.
  if p_idempotency_key is not null then
    if exists (
      select 1 from public.stock_movements
       where idempotency_key like p_idempotency_key || ':%'
    ) then
      return query
        select * from public.stock_movements
         where idempotency_key like p_idempotency_key || ':%'
         order by created_at;
      return;
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_movements)
  loop
    v_key := case
               when p_idempotency_key is null then null
               else p_idempotency_key || ':' || v_index::text
             end;

    return query
      insert into public.stock_movements (
        variant_id, location_id, quantity_delta, reason,
        reference_type, reference_id, note, staff_id, idempotency_key
      )
      values (
        (v_item ->> 'variant_id')::uuid,
        p_location_id,
        (v_item ->> 'quantity_delta')::integer,
        p_reason,
        p_reference_type,
        p_reference_id,
        coalesce(v_item ->> 'note', p_note),
        v_staff_id,
        v_key
      )
      returning *;

    v_index := v_index + 1;
  end loop;
end;
$$;

comment on function public.record_stock_movements is
  'The only supported way to change stock. Runs as one transaction: either '
  'every movement in the batch lands or none of them do.';

revoke execute on function public.record_stock_movements(uuid, public.stock_movement_reason, jsonb, text, text, text, text) from public, anon;
grant execute on function public.record_stock_movements(uuid, public.stock_movement_reason, jsonb, text, text, text, text) to authenticated, service_role;

revoke execute on function public.rebuild_stock_levels() from public, anon, authenticated;
grant execute on function public.rebuild_stock_levels() to service_role;

revoke execute on function public.verify_stock_levels() from public, anon;
grant execute on function public.verify_stock_levels() to authenticated, service_role;
