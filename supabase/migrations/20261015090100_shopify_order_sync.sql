-- Orders: the CRM decides, Shopify follows.
--
-- Until now a website order lived in two places that never spoke after the
-- first message. Changing it in the CRM left the Shopify order as it was;
-- changing it in Shopify left the CRM order as it was, while Shopify's
-- "refund" for the removed item put stock back here as if it had been
-- returned. On #1406 an item came back twice: once from Shopify's refund, once
-- from the same change made in the CRM.
--
-- The rules from here (DECISIONS.md #12):
--
--   * Stock moves only from what the CRM order holds. A Shopify refund never
--     moves stock - a removed item comes back through the order's own lines,
--     a returned parcel through the returns check-in, as for every other
--     channel. And a refund only marks an order refunded when money moved:
--     an edit to a cash-on-delivery order is a "refund" of nothing.
--
--   * A change made in the CRM is queued for Shopify (shopify_order_outbox)
--     and sent by the shopify-order-sync function - straight away from the
--     screen, and every minute from the Worker until it lands. The queue holds
--     the order, not the change: the job makes Shopify's order look like the
--     CRM's, so running it twice is harmless. Rule three of DECISIONS #1, for
--     orders.
--
--   * A change made in Shopify is followed here, while the order has not
--     left the building. After that the goods are with the courier, so it is
--     flagged on Sync issues instead of moving stock. And while a CRM change
--     is still waiting to reach Shopify, the CRM's version wins.

-- --- When Shopify last told us about each order ------------------------------

-- Shopify does not deliver webhooks in order. Without this, an older update
-- arriving late would put back the lines a newer one had already changed.
alter table public.orders add column if not exists shopify_updated_at timestamptz;

-- --- The queue ---------------------------------------------------------------

create table public.shopify_order_outbox (
  order_id     uuid primary key references public.orders (id) on delete cascade,
  action       text not null check (action in ('edit', 'cancel')),
  -- Which request a run was working from: a change made while it ran leaves
  -- the row in place for one more run.
  requested_at timestamptz not null default clock_timestamp(),
  attempts     integer not null default 0,
  next_try_at  timestamptz not null default now(),
  -- One run per order at a time. Two at once would each add the same item.
  claimed_at   timestamptz,
  last_error   text
);

comment on table public.shopify_order_outbox is
  'Website orders whose Shopify copy has not caught up with a change made in the CRM. Drained by the shopify-order-sync function.';

alter table public.shopify_order_outbox enable row level security;

create policy shopify_order_outbox_read on public.shopify_order_outbox
  for select to authenticated
  using (public.is_staff());

create or replace function public.queue_shopify_order_sync(p_order_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_action not in ('edit', 'cancel') then
    raise exception 'Unknown Shopify order action %', p_action using errcode = 'invalid_parameter_value';
  end if;

  -- Only orders that came from Shopify have a Shopify copy to update.
  insert into public.shopify_order_outbox (order_id, action)
  select o.id, p_action
    from public.orders o
   where o.id = p_order_id
     and o.shopify_order_id is not null
  on conflict (order_id) do update
     -- A cancel waiting to go out is not undone by a later edit.
     set action       = case when public.shopify_order_outbox.action = 'cancel'
                             then 'cancel' else excluded.action end,
         requested_at = clock_timestamp(),
         attempts     = 0,
         next_try_at  = now(),
         last_error   = null;
end;
$$;

revoke execute on function public.queue_shopify_order_sync(uuid, text) from public, anon, authenticated;
grant execute on function public.queue_shopify_order_sync(uuid, text) to service_role;

create or replace function public.claim_shopify_order_sync(
  p_limit    integer default 20,
  p_order_id uuid    default null
)
returns table (order_id uuid, action text, requested_at timestamptz, attempts integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'The Shopify order queue is drained by the sync service'
      using errcode = 'insufficient_privilege';
  end if;

  -- One order named: the screen that just changed it, so its backoff does not
  -- apply. Otherwise whatever is due. A claim older than two minutes is a run
  -- that died, and is taken over.
  return query
  with picked as (
    select q.order_id
      from public.shopify_order_outbox q
     where (p_order_id is null or q.order_id = p_order_id)
       and (p_order_id is not null or q.next_try_at <= now())
       and (q.claimed_at is null or q.claimed_at < now() - interval '2 minutes')
     order by q.requested_at
     limit greatest(p_limit, 1)
       for update skip locked
  )
  update public.shopify_order_outbox q
     set claimed_at = now()
    from picked
   where q.order_id = picked.order_id
  returning q.order_id, q.action, q.requested_at, q.attempts;
end;
$$;

revoke execute on function public.claim_shopify_order_sync(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_shopify_order_sync(integer, uuid) to service_role;

-- What the Shopify order should hold: the CRM order's lines, per variant.
create or replace function public.shopify_order_sync_target(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'Read by the sync service' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'order_id',         v_order.id,
    'order_number',     v_order.order_number,
    'shopify_order_id', v_order.shopify_order_id,
    'location_id',      v_order.location_id,
    'cancelled',        v_order.cancelled_at is not null,
    'shipping_egp',     v_order.shipping_egp,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'variant_id',         l.variant_id,
               'shopify_variant_id', v.shopify_variant_id,
               'sku',                l.sku,
               'quantity',           l.quantity
             ) order by l.sku)
        from (
          select li.variant_id, li.sku, sum(li.quantity)::integer as quantity
            from public.order_line_items li
           where li.order_id = v_order.id
           group by li.variant_id, li.sku
        ) l
        left join public.variants v on v.id = l.variant_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.shopify_order_sync_target(uuid) from public, anon, authenticated;
grant execute on function public.shopify_order_sync_target(uuid) to service_role;

create or replace function public.complete_shopify_order_sync(
  p_order_id           uuid,
  p_requested_at       timestamptz,
  p_success            boolean,
  p_error              text        default null,
  p_details            jsonb       default '{}'::jsonb,
  p_shopify_updated_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.shopify_order_outbox;
  v_order public.orders;
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'Completed by the sync service' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.shopify_order_outbox where order_id = p_order_id for update;
  if not found then
    return;
  end if;

  select * into v_order from public.orders where id = p_order_id;

  if p_success then
    -- Shopify's own timestamp for the edit we just made, so a webhook that
    -- left Shopify before it is recognised as older and cannot undo it.
    if p_shopify_updated_at is not null then
      update public.orders
         set shopify_updated_at = greatest(coalesce(shopify_updated_at, p_shopify_updated_at), p_shopify_updated_at)
       where id = p_order_id;
    end if;

    -- In the history when Shopify changed, or when the fee could not be.
    if coalesce((p_details ->> 'changed')::boolean, true)
       or p_details ->> 'shipping_updated' = 'false'
    then
      insert into public.order_events (order_id, event_type, details)
      values (p_order_id, 'shopify_synced', jsonb_build_object('action', v_row.action) || coalesce(p_details, '{}'::jsonb));
    end if;

    if v_row.requested_at = p_requested_at then
      delete from public.shopify_order_outbox where order_id = p_order_id;
    else
      -- Changed again while this run was working: once more, from the top.
      update public.shopify_order_outbox
         set claimed_at = null, next_try_at = now()
       where order_id = p_order_id;
    end if;

    update public.sync_issues
       set status          = 'resolved',
           resolved_at     = now(),
           resolution_note = 'Shopify updated'
     where status = 'open'
       and type = 'order_sync_failed'
       and details ->> 'order_id' = p_order_id::text;
    return;
  end if;

  update public.shopify_order_outbox
     set attempts    = attempts + 1,
         last_error  = left(p_error, 1000),
         claimed_at  = null,
         -- 1, 2, 4, 8... minutes, then hourly.
         next_try_at = now() + least(power(2, attempts)::integer, 60) * interval '1 minute'
   where order_id = p_order_id
  returning * into v_row;

  -- A blip is retried quietly. Three in a row is something a person should see.
  if v_row.attempts >= 3 then
    perform public.open_sync_issue(
      'order_sync_failed', null, v_order.location_id, null, null,
      jsonb_build_object(
        'order_id',     p_order_id,
        'order_number', v_order.order_number,
        'action',       v_row.action,
        'error',        left(p_error, 500)
      ),
      'order_sync'
    );
  end if;
end;
$$;

revoke execute on function public.complete_shopify_order_sync(uuid, timestamptz, boolean, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_shopify_order_sync(uuid, timestamptz, boolean, text, jsonb, timestamptz) to service_role;

-- After a Shopify edit lands, the variants it touched are pushed once more.
-- Adding an item in Shopify takes a unit off its count by itself; if our push
-- of that variant got there first, Shopify is now one short. Pushing again
-- after the edit puts our number back on top, whatever the order of events.
create or replace function public.queue_inventory_push(p_variant_ids uuid[], p_location_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if not (public.is_service_request() or public.is_admin()) then
    raise exception 'Queued by the sync service' using errcode = 'insufficient_privilege';
  end if;

  insert into public.sync_outbox (variant_id, location_id, dirty_since, next_try_at)
  select distinct v.id, p_location_id, now(), now()
    from public.variants v
   where v.id = any (p_variant_ids)
  on conflict (variant_id, location_id) do update
    set dirty_since = least(public.sync_outbox.dirty_since, now()),
        next_try_at = least(public.sync_outbox.next_try_at, now());

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.queue_inventory_push(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.queue_inventory_push(uuid[], uuid) to service_role;

-- --- Sync issues about orders stay one per order -----------------------------

-- An issue with no variant was matched on the Shopify product or inventory
-- item only, so two orders' issues of the same type merged into one row - the
-- same fault fixed for products on 2026-09-29. The order number joins them.
create or replace function public.open_sync_issue(
  p_type             public.sync_issue_type,
  p_variant_id       uuid,
  p_location_id      uuid,
  p_crm_quantity     integer,
  p_shopify_quantity integer,
  p_details          jsonb default '{}'::jsonb,
  p_detected_by      text  default 'nightly_reconcile'
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
         and details ->> 'order_number' is not distinct from p_details ->> 'order_number'
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

-- --- A Shopify refund: money only --------------------------------------------

create or replace function public.apply_shopify_refund(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund_id      bigint;
  v_order_id       bigint;
  v_order          public.orders;
  v_money          numeric(12, 2);
  v_total_refunded numeric(12, 2);
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify refunds are applied by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  v_refund_id := nullif(p_payload ->> 'id', '')::bigint;
  v_order_id  := nullif(p_payload ->> 'order_id', '')::bigint;

  select * into v_order from public.orders where shopify_order_id = v_order_id for update;
  if not found then
    raise exception 'No CRM order for Shopify order %', v_order_id
      using errcode = 'no_data_found';
  end if;

  -- No stock moves here, whatever the refund says about restocking. Shopify
  -- sends a "refund" for an item taken off an order in an edit, and for one
  -- returned by a customer; the first is the order's own lines changing
  -- (sync_shopify_order_lines), the second is a parcel we check in by hand.
  -- Moving stock here as well is what counted #1406's item twice.

  -- Only money actually given back makes an order refunded. Editing a
  -- cash-on-delivery order produces a refund with no transactions at all.
  select coalesce(sum(nullif(t ->> 'amount', '')::numeric), 0)
    into v_money
    from jsonb_array_elements(coalesce(p_payload -> 'transactions', '[]'::jsonb)) t
   where lower(coalesce(t ->> 'kind', '')) = 'refund'
     and lower(coalesce(t ->> 'status', '')) = 'success';

  if v_money > 0 and not exists (
    select 1 from public.order_events
     where order_id = v_order.id
       and event_type = 'shopify_refund'
       and details ->> 'refund_id' = v_refund_id::text
  ) then
    insert into public.order_events (order_id, event_type, note, details)
    values (
      v_order.id, 'shopify_refund', 'Refunded in Shopify',
      jsonb_build_object('refund_id', v_refund_id, 'amount_egp', v_money)
    );

    select coalesce(sum((details ->> 'amount_egp')::numeric), 0)
      into v_total_refunded
      from public.order_events
     where order_id = v_order.id and event_type = 'shopify_refund';

    update public.orders
       set payment_status = case
             when v_total_refunded >= round(total_egp + shipping_egp, 2)
               then 'refunded'::public.payment_status
             else 'partially_refunded'::public.payment_status
           end
     where id = v_order.id;
  end if;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'refunded_egp', v_money,
    'units_restocked', 0
  );
end;
$$;

-- --- A change made in Shopify ------------------------------------------------

create or replace function public.sync_shopify_order_lines(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shopify_id  bigint;
  v_updated_at  timestamptz;
  v_order       public.orders;
  v_item        jsonb;
  v_variant     public.variants;
  v_key         text;
  v_qty         integer;
  v_ordered     integer;
  v_price       numeric(12, 2);
  v_line_disc   numeric(12, 2);
  v_line_total  numeric(12, 2);
  v_subtotal    numeric(12, 2) := 0;
  v_shipping    numeric(12, 2);
  v_shopify     jsonb := '{}'::jsonb;
  v_crm         jsonb;
  v_before      jsonb;
  v_after       jsonb := '{}'::jsonb;
  v_delta       integer;
  v_movements   jsonb := '[]'::jsonb;
  v_touched     uuid[] := '{}';
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify order changes are applied by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  v_shopify_id := nullif(p_payload ->> 'id', '')::bigint;
  if v_shopify_id is null then
    raise exception 'Payload has no order id' using errcode = 'invalid_parameter_value';
  end if;
  v_updated_at := nullif(p_payload ->> 'updated_at', '')::timestamptz;

  select * into v_order from public.orders where shopify_order_id = v_shopify_id for update;

  -- Missed orders/create: this is the order's first appearance.
  if not found then
    v_order := public.ingest_shopify_order(p_payload);
    update public.orders set shopify_updated_at = v_updated_at where id = v_order.id;
    return jsonb_build_object(
      'result', 'created',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'variant_ids', coalesce((
        select jsonb_agg(distinct li.variant_id)
          from public.order_line_items li
         where li.order_id = v_order.id and li.variant_id is not null
      ), '[]'::jsonb)
    );
  end if;

  if v_updated_at is not null
     and v_order.shopify_updated_at is not null
     and v_updated_at <= v_order.shopify_updated_at
  then
    return jsonb_build_object('result', 'stale', 'order_number', v_order.order_number);
  end if;

  update public.orders
     set shopify_updated_at = coalesce(v_updated_at, now())
   where id = v_order.id
  returning * into v_order;

  if v_order.cancelled_at is not null then
    return jsonb_build_object('result', 'cancelled', 'order_number', v_order.order_number);
  end if;

  -- A change made here has not reached Shopify yet, so what Shopify says is
  -- out of date. The queued job will make Shopify match.
  if exists (select 1 from public.shopify_order_outbox where order_id = v_order.id) then
    return jsonb_build_object('result', 'crm_change_pending', 'order_number', v_order.order_number);
  end if;

  -- What Shopify says the order holds now. current_quantity leaves out what
  -- an edit removed; quantity is what was first ordered.
  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb))
  loop
    v_qty := coalesce(nullif(v_item ->> 'current_quantity', '')::integer,
                      nullif(v_item ->> 'quantity', '')::integer, 0);
    continue when v_qty <= 0;

    v_variant := null;
    if nullif(v_item ->> 'variant_id', '') is not null then
      select * into v_variant from public.variants
       where shopify_variant_id = (v_item ->> 'variant_id')::bigint;
    end if;
    if v_variant.id is null and nullif(v_item ->> 'sku', '') is not null then
      select * into v_variant from public.variants where sku = v_item ->> 'sku';
    end if;

    v_key := coalesce(v_variant.id::text, 'sku:' || coalesce(nullif(v_item ->> 'sku', ''), 'UNKNOWN'));
    v_shopify := jsonb_set(v_shopify, array[v_key], to_jsonb(coalesce((v_shopify ->> v_key)::integer, 0) + v_qty));
  end loop;

  select coalesce(jsonb_object_agg(t.k, t.q), '{}'::jsonb)
    into v_crm
    from (
      select coalesce(li.variant_id::text, 'sku:' || li.sku) as k, sum(li.quantity)::integer as q
        from public.order_line_items li
       where li.order_id = v_order.id
       group by 1
    ) t;

  -- The usual case: an address fix, a tag, or our own edit coming back.
  if v_crm = v_shopify then
    return jsonb_build_object('result', 'unchanged', 'order_number', v_order.order_number);
  end if;

  -- The parcel has left, or its money is counted. Nothing in a van moves
  -- stock (DECISIONS #3), so a person decides what this change means.
  if v_order.fulfillment_status not in ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed')
     or v_order.payment_status = 'paid'
     or exists (select 1 from public.settlement_lines where order_id = v_order.id)
  then
    perform public.open_sync_issue(
      'order_changed_in_shopify', null, v_order.location_id, null, null,
      jsonb_build_object(
        'order_id',           v_order.id,
        'order_number',       v_order.order_number,
        'fulfillment_status', v_order.fulfillment_status,
        'shopify_items', coalesce((
          select jsonb_agg((i ->> 'sku') || ' x' || (i ->> 'current_quantity'))
            from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb)) i
           where coalesce(nullif(i ->> 'current_quantity', '')::integer, 0) > 0
        ), '[]'::jsonb),
        'crm_items', coalesce((
          select jsonb_agg(li.sku || ' x' || li.quantity order by li.sku)
            from public.order_line_items li
           where li.order_id = v_order.id
        ), '[]'::jsonb)
      ),
      'webhook'
    );
    return jsonb_build_object('result', 'flagged', 'order_number', v_order.order_number);
  end if;

  -- Follow it. Captured before the lines are rewritten: what the order held,
  -- per tracked variant.
  select coalesce(jsonb_object_agg(t.variant_id::text, t.quantity), '{}'::jsonb)
    into v_before
    from (
      select li.variant_id, sum(li.quantity)::integer as quantity
        from public.order_line_items li
        join public.variants v on v.id = li.variant_id
       where li.order_id = v_order.id and v.track_inventory
       group by li.variant_id
    ) t;

  delete from public.order_line_items where order_id = v_order.id;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb))
  loop
    v_qty := coalesce(nullif(v_item ->> 'current_quantity', '')::integer,
                      nullif(v_item ->> 'quantity', '')::integer, 0);
    continue when v_qty <= 0;
    v_ordered := greatest(coalesce(nullif(v_item ->> 'quantity', '')::integer, v_qty), 1);

    v_variant := null;
    if nullif(v_item ->> 'variant_id', '') is not null then
      select * into v_variant from public.variants
       where shopify_variant_id = (v_item ->> 'variant_id')::bigint;
    end if;
    if v_variant.id is null and nullif(v_item ->> 'sku', '') is not null then
      select * into v_variant from public.variants where sku = v_item ->> 'sku';
    end if;

    v_price      := coalesce(nullif(v_item ->> 'price', '')::numeric, 0);
    -- A line's discount was for the quantity first ordered.
    v_line_disc  := round(coalesce(nullif(v_item ->> 'total_discount', '')::numeric, 0) * v_qty / v_ordered, 2);
    v_line_total := greatest(round(v_price * v_qty, 2) - v_line_disc, 0);

    insert into public.order_line_items (
      order_id, variant_id, sku, title, variant_title,
      quantity, unit_price_egp, discount_egp, total_egp
    )
    values (
      v_order.id, v_variant.id,
      coalesce(nullif(v_item ->> 'sku', ''), 'UNKNOWN'),
      coalesce(nullif(v_item ->> 'title', ''), 'Unknown item'),
      nullif(v_item ->> 'variant_title', ''),
      v_qty, v_price, v_line_disc, v_line_total
    );

    v_subtotal := v_subtotal + v_line_total;

    if v_variant.id is not null and v_variant.track_inventory then
      v_after := jsonb_set(
        v_after,
        array[v_variant.id::text],
        to_jsonb(coalesce((v_after ->> v_variant.id::text)::integer, 0) + v_qty)
      );
    end if;
  end loop;

  -- Stock comes back for what left the order and goes out for what joined it.
  for v_key in select jsonb_object_keys(v_before || v_after)
  loop
    v_delta := coalesce((v_before ->> v_key)::integer, 0) - coalesce((v_after ->> v_key)::integer, 0);
    if v_delta <> 0 then
      v_movements := v_movements || jsonb_build_object('variant_id', v_key::uuid, 'quantity_delta', v_delta);
      v_touched := v_touched || v_key::uuid;
    end if;
  end loop;

  -- The shipping still on the order; an edit can remove a line and add one.
  if jsonb_typeof(p_payload -> 'shipping_lines') = 'array' then
    select coalesce(sum(nullif(s ->> 'price', '')::numeric), 0)
      into v_shipping
      from jsonb_array_elements(p_payload -> 'shipping_lines') s
     where coalesce(s ->> 'is_removed', 'false') <> 'true';
  else
    v_shipping := v_order.shipping_egp;
  end if;

  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         discount_egp = least(discount_egp, round(v_subtotal, 2)),
         total_egp    = greatest(round(v_subtotal - least(discount_egp, v_subtotal), 2), 0),
         shipping_egp = round(v_shipping, 2)
   where id = v_order.id
  returning * into v_order;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'adjustment'::public.stock_movement_reason,
      p_movements       => v_movements,
      p_reference_type  => 'shopify_order_edit',
      p_reference_id    => v_shopify_id::text,
      p_note            => 'Order ' || v_order.order_number || ' edited in Shopify',
      p_idempotency_key => 'shopify-edit:' || v_shopify_id::text || ':'
                           || coalesce(v_updated_at::text, clock_timestamp()::text)
    );
  end if;

  insert into public.order_events (order_id, event_type, note, details)
  values (
    v_order.id, 'items_edited', 'Edited in Shopify',
    jsonb_build_object('source', 'shopify', 'subtotal_egp', v_subtotal, 'movements', v_movements)
  );

  return jsonb_build_object(
    'result', 'updated',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'variant_ids', to_jsonb(v_touched)
  );
end;
$$;

revoke execute on function public.sync_shopify_order_lines(jsonb) from public, anon, authenticated;
grant execute on function public.sync_shopify_order_lines(jsonb) to service_role;

-- --- Changes made in the CRM go to Shopify -----------------------------------

-- As in 20260921200000, plus the last line: a website order's new lines are
-- queued for Shopify.
create or replace function public.update_order_items(p_order_id uuid, p_items jsonb)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  -- A website order: Shopify's copy is brought into line.
  perform public.queue_shopify_order_sync(p_order_id, 'edit');

  return v_order;
end;
$$;

-- As in 20260921200000, plus: a new shipping fee on a website order is queued
-- for Shopify too.
create or replace function public.update_order_details(
  p_order_id       uuid,
  p_shipping_egp   numeric                default null,
  p_discount_egp   numeric                default null,
  p_note           text                   default null,
  p_payment_method public.payment_method  default null,
  p_channel        public.sales_channel   default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_shipping numeric(12, 2);
  v_discount numeric(12, 2);
  v_touches_money boolean;
  v_old_shipping numeric(12, 2);
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

  v_old_shipping := v_order.shipping_egp;
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

  if v_shipping <> v_old_shipping then
    perform public.queue_shopify_order_sync(p_order_id, 'edit');
  end if;

  return v_order;
end;
$$;

-- --- Cancelling --------------------------------------------------------------

-- As before, plus two things for a website order. Cancelled here, it is
-- cancelled in Shopify too - unless the cancellation came from Shopify, which
-- cancel_shopify_order marks for the length of its transaction. And one paid
-- online is refused: cancelling would not refund the customer, Shopify's own
-- cancel screen does.
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders;
  v_movements    jsonb := '[]'::jsonb;
  v_line         record;
  v_from_shopify boolean := coalesce(current_setting('duch.from_shopify', true), '') = 'on';
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

  if v_order.shopify_order_id is not null
     and v_order.payment_status = 'paid'
     and not v_from_shopify
  then
    raise exception 'Order % was paid online. Cancel it in Shopify so the customer is refunded.',
      v_order.order_number
      using errcode = 'check_violation',
            hint = 'cancel_in_shopify';
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

  if v_from_shopify then
    -- Shopify already has it cancelled; an edit still waiting to go out
    -- would only fail against a cancelled order.
    delete from public.shopify_order_outbox where order_id = p_order_id;
  else
    perform public.queue_shopify_order_sync(p_order_id, 'cancel');
  end if;

  return v_order;
end;
$$;

create or replace function public.cancel_shopify_order(p_shopify_order_id bigint, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify cancellations are applied by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where shopify_order_id = p_shopify_order_id;
  if not found then
    raise exception 'No CRM order for Shopify order %', p_shopify_order_id
      using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'cancelled' then
    return v_order;
  end if;

  -- Someone cancelled in Shopify something that is already on a van. The goods
  -- do not come back because a status changed; they come back through the
  -- returns flow. Flagging it is the only honest response.
  if v_order.fulfillment_status in ('in_transit', 'out_for_delivery', 'delivered') then
    perform public.open_sync_issue(
      'missing_in_crm', null, v_order.location_id, null, null,
      jsonb_build_object(
        'reason', 'shopify_cancelled_an_order_already_shipped',
        'order_number', v_order.order_number,
        'fulfillment_status', v_order.fulfillment_status,
        'note', 'Recall the parcel with the courier, then check it in as a return.'
      ),
      'webhook'
    );
    return v_order;
  end if;

  -- Tells cancel_order this came from Shopify, so it does not queue the same
  -- cancellation back. Switched off again straight after: a setting lasts the
  -- whole transaction, and anything cancelled later in it is not Shopify's.
  perform set_config('duch.from_shopify', 'on', true);
  v_order := public.cancel_order(v_order.id, coalesce(p_reason, 'Cancelled in Shopify'));
  perform set_config('duch.from_shopify', '', true);
  return v_order;
end;
$$;

-- --- The Orders screen sees it ----------------------------------------------

-- As in 20261004090000, with two columns on the end.
create or replace view public.v_order_list
with (security_invoker = on) as
select
  o.id,
  o.order_number,
  o.channel,
  o.created_at,
  o.fulfillment_status,
  o.payment_status,
  o.payment_method,
  o.subtotal_egp,
  o.discount_egp,
  o.shipping_egp,
  o.total_egp,
  o.cancelled_at,
  o.note,
  o.customer_id,
  c.full_name                as customer_name,
  c.phone                    as customer_phone,
  nullif(
    concat_ws('، ',
      nullif(trim(c.address_line1), ''),
      nullif(trim(c.address_line2), ''),
      nullif(trim(c.city), ''),
      nullif(trim(c.governorate), '')
    ),
    ''
  )                          as customer_address,
  -- The parcel as it stands: the latest outbound shipment that was not
  -- called off. A shipment cancelled because the order went with our own
  -- driver instead is history, not where the order is.
  s.id                       as shipment_id,
  s.tracking_number,
  s.courier,
  s.driver_name,
  s.status                   as shipment_status,
  s.handed_over_at,
  s.delivered_at,
  s.cod_amount_egp,
  coalesce(li.lines, '[]'::jsonb) as items,
  coalesce(li.unit_count, 0)      as unit_count,
  -- Which list the order belongs in. The screen's tabs are these.
  case
    when o.cancelled_at is not null or o.fulfillment_status = 'cancelled' then 'cancelled'
    when o.fulfillment_status in
         ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup')
      then 'to_ship'
    when o.fulfillment_status in ('in_transit', 'out_for_delivery') then 'on_the_road'
    when o.fulfillment_status = 'delivered' then 'delivered'
    else 'back'
  end                        as stage,
  -- Since when it has been where it is. A parcel on the road counts from
  -- the handover - the same clock as the courier custody report. Otherwise
  -- the moment it reached its current status, from the history; an order
  -- that has never moved has been there since it was created.
  coalesce(
    case when o.fulfillment_status in ('in_transit', 'out_for_delivery') then s.handed_over_at end,
    (select max(e.created_at)
       from public.order_events e
      where e.order_id = o.id
        and e.to_fulfillment = o.fulfillment_status),
    o.created_at
  )                          as stage_since,
  -- Appended (a view can only grow at the end): whether the order came from
  -- Shopify, and whether a change made here is still on its way there.
  o.shopify_order_id,
  exists (
    select 1 from public.shopify_order_outbox q where q.order_id = o.id
  )                          as shopify_pending
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sh.*
    from public.shipments sh
   where sh.order_id = o.id
     and sh.direction = 'outbound'
     and sh.status <> 'cancelled'
   order by sh.created_at desc
   limit 1
) s on true
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'sku', l.sku,
        'title', l.title,
        'variant_title', l.variant_title,
        'quantity', l.quantity,
        'unit_price_egp', l.unit_price_egp,
        'total_egp', l.total_egp
      )
      order by l.created_at
    )                    as lines,
    sum(l.quantity)::int as unit_count
  from public.order_line_items l
  where l.order_id = o.id
) li on true;

-- --- Two orders marked refunded by a refund of nothing -----------------------

-- #1403 and #1406 were edited in Shopify, and the old apply_shopify_refund
-- marked each "partially refunded" with no money moved. That took #1403, a
-- delivered cash-on-delivery order, out of "owed" and made it impossible to
-- mark paid. Chosen by condition rather than by number, and approved by the
-- owner on 2026-10-15: a website order marked refunded by Shopify refunds
-- none of which carried a successful refund transaction.
with wrongly_marked as (
  update public.orders o
     set payment_status = 'pending'
   where o.shopify_order_id is not null
     and o.payment_status in ('partially_refunded', 'refunded')
     and o.payment_method = 'cod'
     and not exists (
       select 1
         from public.webhook_events w
         cross join lateral jsonb_array_elements(coalesce(w.payload -> 'transactions', '[]'::jsonb)) t
        where w.topic = 'refunds/create'
          and w.payload ->> 'order_id' = o.shopify_order_id::text
          and lower(coalesce(t ->> 'kind', '')) = 'refund'
          and lower(coalesce(t ->> 'status', '')) = 'success'
          and coalesce(nullif(t ->> 'amount', '')::numeric, 0) > 0
     )
  returning o.id
)
insert into public.order_events (order_id, event_type, note, details)
select id, 'payment_corrected',
       'Shopify edit was recorded as a refund; no money moved',
       jsonb_build_object('to_payment', 'pending', 'migration', '20261015090100')
  from wrongly_marked;
