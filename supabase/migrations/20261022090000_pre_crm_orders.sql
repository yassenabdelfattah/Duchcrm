-- Website orders from before the CRM: never imported, and the ones that were
-- imported by mistake on 2026-10-22 removed.
--
-- The owner tidied old orders in Shopify that day. Every order touched sent
-- orders/updated, and sync_shopify_order_lines creates an order it does not
-- know - meant for an orders/create that went missing. So 67 orders placed
-- between January and 19 September came in as new, each taking its pieces out
-- of stock. Their stock was already settled: the opening balance of
-- 2026-09-27 was a hand count matched to Shopify's available, which had those
-- orders' units taken off already. The cleanup cancelled most of them again
-- in Shopify, putting their stock back; 23 stayed open in the packing queue
-- holding 64 pieces, and one was "shipped" by mistake with tracking "n".
--
-- Two things here, the second approved by the owner on 2026-10-22 ("remove
-- anything before we started the crm"):
--   1. The CRM ignores Shopify messages about orders placed before go-live.
--      shopify_orders_since is the line; nothing older is ever imported.
--   2. The 67 are removed: their remaining stock is given back with a
--      correcting movement per order, so the ledger keeps the whole story,
--      then the orders, their lines, history, the stray shipment, the three
--      cancels stuck on their way to Shopify (deleted there), their Sync
--      issues, and the customers created only for them.

insert into public.settings (key, value, description) values
  ('shopify_orders_since', '"2026-09-27T00:00:00+03:00"'::jsonb,
   'Website orders placed before this belong to the time before the CRM: their stock was in the opening count. Messages about them are ignored, never imported. See DECISIONS.md #12.')
on conflict (key) do nothing;

-- --- Never again -----------------------------------------------------------------

-- As in 20261015090100, except an unknown order placed before go-live is
-- ignored instead of imported.
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

-- --- The orders imported by mistake ---------------------------------------------

-- Archived, not deleted. Their history stays where it is - order_events is
-- append-only on purpose, and an order that existed in the CRM for an
-- afternoon still did - but they leave every screen and every count.
alter table public.orders
  add column if not exists archived_at     timestamptz,
  add column if not exists archived_reason text;

comment on column public.orders.archived_at is
  'Set on an order that should never have been in the CRM. Archived orders are left out of every list and count.';

-- Which orders: a website order whose Shopify creation date, from the last
-- message Shopify sent about it, is before go-live. Chosen by that condition
-- rather than by number.
create temporary table pre_crm_orders as
with last as (
  select distinct on (w.payload ->> 'id')
         w.payload ->> 'id' as shopify_id,
         w.payload ->> 'created_at' as shopify_created_at
    from public.webhook_events w
   where w.topic in ('orders/create', 'orders/updated', 'orders/cancelled')
     and w.payload ->> 'created_at' is not null
   order by w.payload ->> 'id', w.received_at desc
)
select o.id, o.order_number, o.customer_id, o.location_id, o.shopify_order_id
  from public.orders o
  join last l on l.shopify_id = o.shopify_order_id::text
 where l.shopify_created_at::timestamptz < '2026-09-27T00:00:00+03:00';

do $$
declare
  v_order     record;
  v_movements jsonb;
  v_blocked   text;
begin
  -- Anything with money or goods attached that this cannot simply undo stops
  -- the whole migration rather than being half cleaned.
  select string_agg(p.order_number, ', ')
    into v_blocked
    from pre_crm_orders p
   where exists (select 1 from public.returns r where r.order_id = p.id or r.replacement_order_id = p.id)
      or exists (select 1 from public.settlement_lines sl where sl.order_id = p.id)
      or exists (select 1 from public.orders x where x.exchange_for_order_id = p.id);

  if v_blocked is not null then
    raise exception 'Pre-CRM orders with returns, statements or exchanges, left for a person: %', v_blocked;
  end if;

  -- Give back what each still holds: the negative of everything its own
  -- movements did - the import, any cancellation, any edit.
  for v_order in select * from pre_crm_orders order by order_number
  loop
    select coalesce(jsonb_agg(jsonb_build_object('variant_id', t.variant_id, 'quantity_delta', -t.net)), '[]'::jsonb)
      into v_movements
      from (
        select m.variant_id, sum(m.quantity_delta)::integer as net
          from public.stock_movements m
         where m.location_id = v_order.location_id
           and (
             (m.reference_type in ('shopify_order', 'shopify_order_edit') and m.reference_id = v_order.shopify_order_id::text)
             or (m.reference_type in ('order', 'order_cancellation') and m.reference_id = v_order.id::text)
           )
         group by m.variant_id
        having sum(m.quantity_delta) <> 0
      ) t;

    if jsonb_array_length(v_movements) > 0 then
      perform public.record_stock_movements(
        p_location_id     => v_order.location_id,
        p_reason          => 'adjustment'::public.stock_movement_reason,
        p_movements       => v_movements,
        p_reference_type  => 'pre_crm_cleanup',
        p_reference_id    => v_order.shopify_order_id::text,
        p_note            => 'Order ' || v_order.order_number || ' from before the CRM, imported by mistake on 2026-10-22 - archived',
        p_idempotency_key => 'pre-crm-cleanup:' || v_order.shopify_order_id::text
      );
    end if;
  end loop;
end;
$$;

-- Closed and archived. Set directly rather than through cancel_order: the
-- stock is settled above, and Shopify must not be sent a cancellation.
update public.orders o
   set fulfillment_status = 'cancelled',
       cancelled_at       = coalesce(o.cancelled_at, now()),
       cancel_reason      = coalesce(o.cancel_reason, 'Order from before the CRM'),
       archived_at        = now(),
       archived_reason    = 'before_crm'
 where o.id in (select id from pre_crm_orders);

-- The one "shipped" with tracking "n" is not with the courier.
update public.shipments
   set status = 'cancelled'
 where order_id in (select id from pre_crm_orders)
   and status <> 'cancelled';

-- Cancels on their way to orders Shopify no longer has.
delete from public.shopify_order_outbox where order_id in (select id from pre_crm_orders);

update public.sync_issues
   set status          = 'resolved',
       resolved_at     = now(),
       resolution_note = 'Order from before the CRM, archived'
 where status = 'open'
   and (details ->> 'order_id' in (select id::text from pre_crm_orders)
        or details ->> 'order_number' in (select order_number from pre_crm_orders));

drop table pre_crm_orders;

-- --- Out of sight ------------------------------------------------------------------

-- The Orders screen, its tabs and the home screen's counts all read this.
-- Same columns as in 20261021090000; only the rows change.
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
  )                          as shopify_pending,
  -- Appended for exchanges: on a replacement, what it replaced and any
  -- difference owed back; on an original, the replacements made for it.
  o.exchange_for_order_id,
  (select x.order_number from public.orders x where x.id = o.exchange_for_order_id)
                             as exchange_for_order_number,
  o.exchange_refund_egp,
  o.exchange_refunded_at,
  (select string_agg(x.order_number, '، ' order by x.created_at)
     from public.orders x
    where x.exchange_for_order_id = o.id and x.cancelled_at is null)
                             as exchanged_in
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
) li on true
where o.archived_at is null;
