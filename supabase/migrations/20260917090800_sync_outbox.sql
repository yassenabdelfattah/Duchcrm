-- ---------------------------------------------------------------------------
-- The outbox that guarantees Shopify eventually hears about a stock change.
--
-- The obvious design is "after a sale, the sale screen calls the push
-- function". That works right up until the cashier's phone loses signal, or
-- the tab is closed, or the function is briefly rate limited - and then the
-- storefront is quietly selling stock we no longer have.
--
-- So every stock movement marks its variant as dirty here, in the same
-- transaction that wrote the movement. Two things drain it:
--
--   fast path  the sale screen calls push-inventory straight away, so the
--              storefront usually updates within a second;
--   safety net the Worker drains anything still dirty every minute.
--
-- If the fast path fails, nothing is lost - it is still in the outbox.
-- ---------------------------------------------------------------------------

create table public.sync_outbox (
  variant_id   uuid not null references public.variants (id) on delete cascade,
  location_id  uuid not null references public.locations (id) on delete cascade,
  dirty_since  timestamptz not null default now(),
  attempts     integer not null default 0,
  last_error   text,
  next_try_at  timestamptz not null default now(),
  primary key (variant_id, location_id)
);

comment on table public.sync_outbox is
  'Variants whose quantity has changed but has not been confirmed to Shopify.';

create index sync_outbox_ready_idx on public.sync_outbox (next_try_at);

alter table public.sync_outbox enable row level security;

create policy sync_outbox_select on public.sync_outbox
  for select to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')));

-- --- Marking dirty ---------------------------------------------------------

create or replace function public.stock_movements_mark_dirty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Same transaction as the movement itself: if the sale rolls back, so does
  -- the intent to push.
  insert into public.sync_outbox (variant_id, location_id, dirty_since, next_try_at)
  values (new.variant_id, new.location_id, now(), now())
  on conflict (variant_id, location_id) do update
    set dirty_since = least(public.sync_outbox.dirty_since, now()),
        next_try_at = least(public.sync_outbox.next_try_at, now());

  return new;
end;
$$;

-- Runs after stock_movements_apply_trg, so stock_levels already holds the new
-- quantity by the time anything reads the outbox.
create trigger stock_movements_mark_dirty_trg
  after insert on public.stock_movements
  for each row execute function public.stock_movements_mark_dirty();

-- --- Draining --------------------------------------------------------------

create or replace function public.claim_sync_outbox(p_limit integer default 50)
returns table (variant_id uuid, location_id uuid, attempts integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'The outbox is drained by the sync service'
      using errcode = 'insufficient_privilege';
  end if;

  -- skip locked so two Worker invocations overlapping never fight over the
  -- same row; the second simply takes the next batch.
  return query
  with claimed as (
    select o.variant_id, o.location_id
      from public.sync_outbox o
     where o.next_try_at <= now()
     order by o.next_try_at
     limit greatest(1, least(p_limit, 250))
     for update skip locked
  )
  update public.sync_outbox o
     set attempts    = o.attempts + 1,
         -- Hold the row back while the push is in flight. If the Worker dies
         -- mid-push the row becomes eligible again a minute later.
         next_try_at = now() + interval '60 seconds'
    from claimed c
   where o.variant_id = c.variant_id
     and o.location_id = c.location_id
  returning o.variant_id, o.location_id, o.attempts;
end;
$$;

create or replace function public.resolve_sync_outbox(
  p_variant_id  uuid,
  p_location_id uuid,
  p_success     boolean,
  p_error       text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'The outbox is drained by the sync service'
      using errcode = 'insufficient_privilege';
  end if;

  if p_success then
    delete from public.sync_outbox
     where variant_id = p_variant_id and location_id = p_location_id;
    return;
  end if;

  select attempts into v_attempts
    from public.sync_outbox
   where variant_id = p_variant_id and location_id = p_location_id;

  -- Exponential backoff, capped at an hour, so a variant Shopify keeps
  -- rejecting does not consume every run.
  update public.sync_outbox
     set last_error  = p_error,
         next_try_at = now() + make_interval(
           secs => least(3600, power(2, least(coalesce(v_attempts, 1), 12))::int * 30)
         )
   where variant_id = p_variant_id and location_id = p_location_id;

  -- Persistent failure is something a person needs to look at.
  if coalesce(v_attempts, 0) >= 5 then
    perform public.open_sync_issue(
      'push_failed', p_variant_id, p_location_id, null, null,
      jsonb_build_object('error', p_error, 'attempts', v_attempts),
      'outbox'
    );
  end if;
end;
$$;

revoke execute on function public.claim_sync_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_sync_outbox(integer) to service_role;

revoke execute on function public.resolve_sync_outbox(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.resolve_sync_outbox(uuid, uuid, boolean, text) to service_role;
