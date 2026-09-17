-- ---------------------------------------------------------------------------
-- Phase 2: pushing stock to Shopify, and noticing when the two disagree.
--
-- The loop we have to avoid:
--   we push a quantity to Shopify
--     -> Shopify fires inventory_levels/update back at us
--       -> if we treated that as news, we would record a movement
--         -> which would push to Shopify again, forever.
--
-- The way out is that the webhook handler never writes stock. It classifies
-- what it received and records the classification. Only the nightly job opens
-- a sync issue, and only a person resolves one.
-- ---------------------------------------------------------------------------

create type public.sync_push_status as enum ('pending', 'succeeded', 'failed', 'skipped');

create table public.shopify_inventory_pushes (
  id                         uuid primary key default gen_random_uuid(),
  variant_id                 uuid not null references public.variants (id) on delete cascade,
  location_id                uuid not null references public.locations (id) on delete cascade,
  shopify_inventory_item_id  bigint not null,
  shopify_location_id        bigint not null,
  quantity                   integer not null,
  compare_quantity           integer,
  -- Shopify has required an idempotency key on inventory mutations since API
  -- version 2026-04. Reusing one key per push means a retry after a timeout
  -- cannot apply the change twice.
  idempotency_key            uuid not null unique default gen_random_uuid(),
  status                     public.sync_push_status not null default 'pending',
  attempts                   integer not null default 0,
  request                    jsonb,
  response                   jsonb,
  error                      text,
  created_at                 timestamptz not null default now(),
  completed_at               timestamptz
);

comment on table public.shopify_inventory_pushes is
  'Every outbound inventory write, successful or not. Doubles as the record '
  'that lets the webhook handler recognise its own echo coming back.';

create index shopify_pushes_variant_idx
  on public.shopify_inventory_pushes (variant_id, location_id, created_at desc);
create index shopify_pushes_pending_idx
  on public.shopify_inventory_pushes (status, created_at)
  where status in ('pending', 'failed');
create index shopify_pushes_item_idx
  on public.shopify_inventory_pushes (shopify_inventory_item_id, created_at desc);

-- --- Sync issues -----------------------------------------------------------

create type public.sync_issue_type as enum (
  'quantity_mismatch',
  'missing_in_shopify',
  'missing_in_crm',
  'push_failed',
  'unmapped_inventory_item'
);

create type public.sync_issue_status as enum ('open', 'acknowledged', 'resolved', 'ignored');

create table public.sync_issues (
  id              uuid primary key default gen_random_uuid(),
  type            public.sync_issue_type not null,
  variant_id      uuid references public.variants (id) on delete cascade,
  location_id     uuid references public.locations (id) on delete cascade,
  crm_quantity    integer,
  shopify_quantity integer,
  details         jsonb not null default '{}'::jsonb,
  status          public.sync_issue_status not null default 'open',
  detected_by     text not null default 'nightly_reconcile',
  detected_at     timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  occurrences     integer not null default 1,
  resolved_at     timestamptz,
  resolved_by     uuid references public.staff (id) on delete set null,
  resolution_note text
);

comment on table public.sync_issues is
  'Disagreements between the CRM and Shopify. Recorded for a person to judge - '
  'nothing here is ever fixed automatically.';

-- One open issue per variant, location and type. Without this the nightly job
-- would file a fresh copy of the same complaint every single night.
create unique index sync_issues_open_unique_idx
  on public.sync_issues (type, variant_id, location_id)
  where status = 'open';

create index sync_issues_status_idx on public.sync_issues (status, detected_at desc);

-- --- Recording a push ------------------------------------------------------

create or replace function public.begin_inventory_push(
  p_variant_id  uuid,
  p_location_id uuid
)
returns public.shopify_inventory_pushes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_push       public.shopify_inventory_pushes;
  v_item_id    bigint;
  v_shop_loc   bigint;
  v_quantity   integer;
  v_pushed     integer;
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Inventory pushes are made by the sync service'
      using errcode = 'insufficient_privilege';
  end if;

  select v.shopify_inventory_item_id into v_item_id
    from public.variants v where v.id = p_variant_id;

  select l.shopify_location_id into v_shop_loc
    from public.locations l where l.id = p_location_id;

  if v_item_id is null or v_shop_loc is null then
    perform public.open_sync_issue(
      'unmapped_inventory_item', p_variant_id, p_location_id, null, null,
      jsonb_build_object('reason', 'variant or location is not linked to Shopify'),
      'push'
    );
    raise exception 'Variant % or location % is not linked to Shopify',
      p_variant_id, p_location_id
      using errcode = 'foreign_key_violation';
  end if;

  select sl.quantity, sl.shopify_pushed_quantity
    into v_quantity, v_pushed
    from public.stock_levels sl
   where sl.variant_id = p_variant_id
     and sl.location_id = p_location_id;

  v_quantity := coalesce(v_quantity, 0);

  insert into public.shopify_inventory_pushes (
    variant_id, location_id, shopify_inventory_item_id, shopify_location_id,
    quantity, compare_quantity, status
  )
  values (
    p_variant_id, p_location_id, v_item_id, v_shop_loc,
    v_quantity, v_pushed, 'pending'
  )
  returning * into v_push;

  return v_push;
end;
$$;

create or replace function public.complete_inventory_push(
  p_push_id  uuid,
  p_status   public.sync_push_status,
  p_response jsonb default null,
  p_error    text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_push public.shopify_inventory_pushes;
begin
  update public.shopify_inventory_pushes
     set status       = p_status,
         response     = coalesce(p_response, response),
         error        = p_error,
         attempts     = attempts + 1,
         completed_at = now()
   where id = p_push_id
  returning * into v_push;

  if not found then
    raise exception 'Push % not found', p_push_id using errcode = 'no_data_found';
  end if;

  if p_status = 'succeeded' then
    -- Remembering what we sent, and when, is what lets the webhook handler
    -- recognise the echo that Shopify is about to send back.
    update public.stock_levels
       set shopify_pushed_quantity = v_push.quantity,
           shopify_pushed_at       = now()
     where variant_id = v_push.variant_id
       and location_id = v_push.location_id;

    update public.sync_issues
       set status = 'resolved',
           resolved_at = now(),
           resolution_note = 'Cleared by a successful push'
     where status = 'open'
       and type in ('push_failed', 'quantity_mismatch')
       and variant_id = v_push.variant_id
       and location_id = v_push.location_id;

  elsif p_status = 'failed' then
    perform public.open_sync_issue(
      'push_failed', v_push.variant_id, v_push.location_id,
      v_push.quantity, null,
      jsonb_build_object('error', p_error, 'push_id', p_push_id),
      'push'
    );
  end if;
end;
$$;

-- --- Opening an issue ------------------------------------------------------

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

comment on function public.open_sync_issue is
  'Opens an issue, or bumps the existing open one. Never two rows for the '
  'same ongoing problem.';

-- --- Echo detection --------------------------------------------------------
--
-- Called by the webhook handler for every inventory_levels/update. It answers
-- one question - is this news? - and writes nothing to the ledger either way.

create or replace function public.classify_inventory_webhook(
  p_inventory_item_id  bigint,
  p_shopify_location_id bigint,
  p_available          integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant_id   uuid;
  v_location_id  uuid;
  v_quantity     integer;
  v_pushed_qty   integer;
  v_pushed_at    timestamptz;
  v_window       integer;
begin
  select v.id into v_variant_id
    from public.variants v
   where v.shopify_inventory_item_id = p_inventory_item_id;

  if v_variant_id is null then
    return jsonb_build_object(
      'classification', 'unmapped',
      'reason', 'No variant carries this shopify_inventory_item_id'
    );
  end if;

  select l.id into v_location_id
    from public.locations l
   where l.shopify_location_id = p_shopify_location_id;

  if v_location_id is null then
    return jsonb_build_object(
      'classification', 'unmapped',
      'reason', 'No location carries this shopify_location_id',
      'variant_id', v_variant_id
    );
  end if;

  select sl.quantity, sl.shopify_pushed_quantity, sl.shopify_pushed_at
    into v_quantity, v_pushed_qty, v_pushed_at
    from public.stock_levels sl
   where sl.variant_id = v_variant_id
     and sl.location_id = v_location_id;

  v_quantity := coalesce(v_quantity, 0);

  select coalesce((value #>> '{}')::integer, 120) into v_window
    from public.settings where key = 'echo_window_seconds';

  -- Our own push coming home.
  if v_pushed_qty is not null
     and v_pushed_qty = p_available
     and v_pushed_at is not null
     and v_pushed_at > now() - make_interval(secs => coalesce(v_window, 120))
  then
    return jsonb_build_object(
      'classification', 'echo',
      'variant_id', v_variant_id,
      'location_id', v_location_id,
      'crm_quantity', v_quantity,
      'shopify_quantity', p_available
    );
  end if;

  -- Shopify already agrees with us. Most commonly this is Shopify telling us
  -- about the decrement it made itself when an online order was placed, which
  -- our orders/create handler has already recorded.
  if v_quantity = p_available then
    return jsonb_build_object(
      'classification', 'in_agreement',
      'variant_id', v_variant_id,
      'location_id', v_location_id,
      'crm_quantity', v_quantity,
      'shopify_quantity', p_available
    );
  end if;

  -- A genuine difference. It might be someone editing stock in the Shopify
  -- admin, or it might be an orders/create webhook that has not landed yet -
  -- Shopify does not guarantee delivery order. We do not guess and we do not
  -- correct anything; the nightly job decides, by which time any in-flight
  -- webhook has long since arrived.
  return jsonb_build_object(
    'classification', 'divergent',
    'variant_id', v_variant_id,
    'location_id', v_location_id,
    'crm_quantity', v_quantity,
    'shopify_quantity', p_available,
    'difference', p_available - v_quantity
  );
end;
$$;

-- --- Nightly reconciliation ------------------------------------------------
--
-- The Worker fetches every inventory level from Shopify and hands the whole
-- list to this function. Comparing in one pass, well after the day's webhooks
-- have settled, is what makes a difference here meaningful.

create or replace function public.reconcile_shopify_inventory(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row        jsonb;
  v_variant_id uuid;
  v_location_id uuid;
  v_crm        integer;
  v_shopify    integer;
  v_tolerance  integer;
  v_checked    integer := 0;
  v_mismatched integer := 0;
  v_unmapped   integer := 0;
  v_seen       uuid[] := '{}';
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'Reconciliation runs as the sync service'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce((value #>> '{}')::integer, 0) into v_tolerance
    from public.settings where key = 'reconcile_tolerance';

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_checked := v_checked + 1;
    v_shopify := (v_row ->> 'available')::integer;

    select v.id into v_variant_id
      from public.variants v
     where v.shopify_inventory_item_id = (v_row ->> 'inventory_item_id')::bigint;

    select l.id into v_location_id
      from public.locations l
     where l.shopify_location_id = (v_row ->> 'location_id')::bigint;

    if v_variant_id is null or v_location_id is null then
      v_unmapped := v_unmapped + 1;
      perform public.open_sync_issue(
        'unmapped_inventory_item', v_variant_id, v_location_id, null, v_shopify,
        v_row, 'nightly_reconcile'
      );
      continue;
    end if;

    v_seen := v_seen || v_variant_id;

    select coalesce(sl.quantity, 0) into v_crm
      from public.stock_levels sl
     where sl.variant_id = v_variant_id
       and sl.location_id = v_location_id;

    v_crm := coalesce(v_crm, 0);

    if abs(v_crm - v_shopify) > coalesce(v_tolerance, 0) then
      v_mismatched := v_mismatched + 1;
      perform public.open_sync_issue(
        'quantity_mismatch', v_variant_id, v_location_id, v_crm, v_shopify,
        jsonb_build_object('difference', v_shopify - v_crm),
        'nightly_reconcile'
      );
    else
      -- Agreement closes any open complaint about this pair.
      update public.sync_issues
         set status = 'resolved',
             resolved_at = now(),
             resolution_note = 'Quantities agreed at nightly reconciliation'
       where status = 'open'
         and type = 'quantity_mismatch'
         and variant_id = v_variant_id
         and location_id = v_location_id;
    end if;
  end loop;

  -- Anything the CRM tracks that Shopify did not report back at all.
  perform public.open_sync_issue(
    'missing_in_shopify', sl.variant_id, sl.location_id, sl.quantity, null,
    jsonb_build_object('note', 'Shopify returned no inventory level for this variant'),
    'nightly_reconcile'
  )
  from public.stock_levels sl
  join public.variants v on v.id = sl.variant_id
  where v.track_inventory
    and v.is_active
    and v.shopify_inventory_item_id is not null
    and not (sl.variant_id = any (v_seen));

  return jsonb_build_object(
    'checked', v_checked,
    'mismatched', v_mismatched,
    'unmapped', v_unmapped,
    'ran_at', now()
  );
end;
$$;

-- --- Resolving an issue ----------------------------------------------------

create or replace function public.resolve_sync_issue(
  p_issue_id uuid,
  p_action   text,          -- 'trust_crm' | 'trust_shopify' | 'ignore'
  p_note     text default null
)
returns public.sync_issues
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.sync_issues;
begin
  if not (public.is_admin() or public.has_any_role('stock_manager')) then
    raise exception 'Only an admin or stock manager may resolve a sync issue'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_issue from public.sync_issues where id = p_issue_id for update;
  if not found then
    raise exception 'Sync issue % not found', p_issue_id using errcode = 'no_data_found';
  end if;

  if p_action = 'trust_shopify' then
    -- The person has decided Shopify's count is the real one. We do not edit
    -- the ledger; we append an adjustment that says so, signed by them.
    if v_issue.variant_id is null or v_issue.location_id is null then
      raise exception 'This issue has no variant to adjust'
        using errcode = 'invalid_parameter_value';
    end if;

    perform public.record_stock_movements(
      p_location_id    => v_issue.location_id,
      p_reason         => 'adjustment',
      p_movements      => jsonb_build_array(jsonb_build_object(
                            'variant_id', v_issue.variant_id,
                            'quantity_delta', v_issue.shopify_quantity - v_issue.crm_quantity
                          )),
      p_reference_type => 'sync_issue',
      p_reference_id   => v_issue.id::text,
      p_note           => coalesce(p_note, 'Accepted the Shopify count at reconciliation')
    );

  elsif p_action not in ('trust_crm', 'ignore') then
    raise exception 'Unknown action %. Use trust_crm, trust_shopify or ignore', p_action
      using errcode = 'invalid_parameter_value';
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
$$;

revoke execute on function public.reconcile_shopify_inventory(jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_shopify_inventory(jsonb) to service_role;

revoke execute on function public.resolve_sync_issue(uuid, text, text) from public, anon;
grant execute on function public.resolve_sync_issue(uuid, text, text) to authenticated, service_role;

revoke execute on function public.begin_inventory_push(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_inventory_push(uuid, uuid) to service_role;

revoke execute on function public.complete_inventory_push(uuid, public.sync_push_status, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_inventory_push(uuid, public.sync_push_status, jsonb, text) to service_role;
