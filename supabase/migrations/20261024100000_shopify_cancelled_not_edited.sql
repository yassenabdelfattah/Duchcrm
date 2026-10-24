-- Shopify's orders/updated for a cancelled order is not an edit.
--
-- Cancelling a returned order in Shopify (to close it, 20261024090000) also
-- sends orders/updated with every line at zero. sync_shopify_order_lines read
-- that as the items changing after the parcel shipped, and opened an "order
-- changed in Shopify" issue for #1418 and #1420 with nothing in Shopify's
-- list. A cancelled Shopify order is now left to orders/cancelled, and the two
-- false alarms are closed.

-- As in 20261022090000, plus the cancelled check.
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

  if not found then
    -- Placed before the CRM existed: history, not a missed order. Its stock
    -- was in the opening count, so importing it would take it out twice -
    -- which is what tidying old orders in Shopify did on 2026-10-22.
    if nullif(p_payload ->> 'created_at', '')::timestamptz < coalesce(
         (select (s.value #>> '{}')::timestamptz from public.settings s where s.key = 'shopify_orders_since'),
         '-infinity'::timestamptz)
    then
      return jsonb_build_object('result', 'before_crm', 'order_number', p_payload ->> 'name');
    end if;

    -- Missed orders/create: this is the order's first appearance.
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

  -- Cancelled in Shopify: its lines all going to nothing is the cancellation,
  -- not an edit to follow or to flag. orders/cancelled says what it means here
  -- - closing a returned order flagged two false alarms on 2026-10-24.
  if nullif(p_payload ->> 'cancelled_at', '') is not null then
    return jsonb_build_object('result', 'cancelled_in_shopify', 'order_number', v_order.order_number);
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

update public.sync_issues
   set status          = 'resolved',
       resolved_at     = now(),
       resolution_note = 'Cancelled in Shopify to close it, not an edit'
 where status = 'open'
   and type = 'order_changed_in_shopify'
   and details -> 'shopify_items' = '[]'::jsonb;
