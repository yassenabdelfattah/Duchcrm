-- ---------------------------------------------------------------------------
-- Sync issues: checking against Shopify on demand, and accepting Shopify's
-- count for a whole product at once.
--
-- Found on day three of go-live. Stock was edited in the Shopify admin for
-- two slipper products, and two new slipper products were created there with
-- stock. The nightly check duly reported it - 43 quantity differences and 36
-- items it did not recognise - but settling that meant waiting for midnight
-- and then answering each size separately, while every sale in the meantime
-- pushed the CRM's old number over the edit in Shopify.
--
-- The rules do not change: Shopify still never changes our stock by itself,
-- and a person still decides, with their name on it. What changes:
--
--   * Items reported as unrecognised close once an import links them to a
--     variant. They were only unrecognised because the product had not been
--     imported yet.
--   * An issue that is already settled cannot be settled again. Before this,
--     answering "Shopify is right" twice added the correction twice.
--   * "The CRM is right" sends our number to Shopify again, as the screen has
--     always said it does. It used to only close the issue.
--   * Several issues can be settled in one go, all or nothing.
-- ---------------------------------------------------------------------------

-- --- Unrecognised items that an import has since linked ---------------------

create or replace function public.close_linked_unmapped_issues()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed integer;
begin
  if not (public.is_service_request()
          or public.is_admin()
          or public.has_any_role('stock_manager')) then
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
$$;

comment on function public.close_linked_unmapped_issues() is
  'Closes "unrecognised Shopify item" issues whose inventory item now belongs '
  'to a CRM variant. Run by the import and by every reconciliation.';

revoke execute on function public.close_linked_unmapped_issues() from public, anon;
grant execute on function public.close_linked_unmapped_issues() to authenticated, service_role;

-- --- Reconciliation, now tidying up after imports ---------------------------
--
-- Unchanged apart from the call at the top.

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
  v_linked     integer := 0;
  v_seen       uuid[] := '{}';
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'Reconciliation runs as the sync service'
      using errcode = 'insufficient_privilege';
  end if;

  v_linked := public.close_linked_unmapped_issues();

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
    'linked_since_last_check', v_linked,
    'ran_at', now()
  );
end;
$$;

-- --- Settling one issue ----------------------------------------------------

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
  v_delta integer;
begin
  if not (public.is_admin() or public.has_any_role('stock_manager')) then
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
$$;

-- --- Settling several at once ------------------------------------------------

create or replace function public.resolve_sync_issues(
  p_issue_ids uuid[],
  p_action    text,
  p_note      text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      uuid;
  v_settled integer := 0;
begin
  if not (public.is_admin() or public.has_any_role('stock_manager')) then
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
$$;

comment on function public.resolve_sync_issues(uuid[], text, text) is
  'Settles several sync issues with the same answer, all or nothing. Issues '
  'already settled are skipped.';

revoke execute on function public.resolve_sync_issues(uuid[], text, text) from public, anon;
grant execute on function public.resolve_sync_issues(uuid[], text, text) to authenticated, service_role;

-- The new slipper products were imported after the check that reported their
-- items as unrecognised. They are recognised now.
select public.close_linked_unmapped_issues();
