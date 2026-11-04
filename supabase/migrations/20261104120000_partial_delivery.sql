-- Delivered in part, recorded the moment it happens (2026-11-04).
--
-- A customer who keeps some of a parcel and hands the rest back to the
-- courier could only be recorded once the refused pieces were on the table at
-- Returns, where the check-in asks what stayed with the customer (#14). Until
-- then the order sat with the courier, owed in full, and a statement that
-- arrived first showed it collected short. The owner asked for it on the
-- order: say which pieces the customer took and which are coming back, so
-- every piece can be followed.
--
-- record_partial_delivery does, in one step:
--  * the order and its parcel are delivered - of what was kept. Our own
--    driver's cash comes in with it, as "cash received" does;
--  * a refusal at the door is opened for the rest, coming back with the
--    courier, with a line for every piece: what stayed (quantity_kept) and
--    what is coming back (quantity_expected). It is on Returns' coming-back
--    list, and its check-in starts from these counts. Stock comes back only
--    then, when the pieces are counted (#3);
--  * the refused pieces come off what is owed at once (the owner's choice):
--    the order's total, the owed list and what the courier's statement should
--    say. A refusal at the door is paid nothing for, unless the order was paid
--    online before it left - then it is owed back (20261102100000).
--
-- It works on an order with the courier or our driver, and on one already
-- marked delivered with nothing back on it yet (the owner's choice) - marked
-- in a batch, and then the statement says the customer kept only part.
--
-- A recorded refusal that is still on its way back counts the way a checked-in
-- one does wherever money is reckoned. Which ones those are: a refusal at the
-- door where the customer kept something - recorded here, or at a check-in.
-- A whole refusal still with the courier is not one; its order is not
-- delivered, and nothing is reckoned off it until it is back.

-- --- What came off the bill ---------------------------------------------------------------

-- As in 20261102090000, plus a refusal at the door that kept something, from
-- when it is recorded. Its value is set then.
create or replace function public.order_returned_off_egp(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(r.value_egp - r.refund_egp), 0)
    from public.returns r
   where r.order_id = p_order_id
     and r.type <> 'exchange'
     and (r.status in ('received', 'discrepancy', 'closed')
          or (r.type = 'failed_delivery'
              and exists (select 1 from public.return_lines k
                           where k.return_id = r.id and k.quantity_kept > 0)));
$$;

-- As in 20261102090000, and the same refusals as above: the statement's
-- products leave them out from when they are recorded.
create or replace function public.order_line_refused(p_line_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(rl.quantity_expected), 0)::integer
    from public.return_lines rl
    join public.returns r on r.id = rl.return_id
   where rl.order_line_item_id = p_line_id
     and r.type = 'failed_delivery'
     and (r.status in ('received', 'discrepancy', 'closed')
          or exists (select 1 from public.return_lines k
                      where k.return_id = r.id and k.quantity_kept > 0));
$$;

-- --- Recording it -------------------------------------------------------------------------

-- p_lines: [{order_line_item_id, quantity_kept}] - how many of each line the
-- customer took. A line left out was refused whole.
create or replace function public.record_partial_delivery(
  p_order_id uuid,
  p_lines    jsonb,
  p_reason   public.return_reason default 'refused_after_inspection',
  p_note     text default null
)
returns public.returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order      public.orders;
  v_shipment   public.shipments;
  v_return     public.returns;
  v_item       jsonb;
  v_line       record;
  v_kept_total integer := 0;
  v_back_total integer := 0;
  v_value      numeric(12, 2);
begin
  -- The people who can mark a parcel delivered.
  if not (public.has_permission('orders.settle')
          or public.has_permission('orders.ship')
          or public.is_service_request()) then
    raise exception 'Not allowed to record a delivery' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'Order % is cancelled', v_order.order_number using errcode = 'check_violation';
  end if;

  -- A replacement's parcel also brings the exchange's old piece back, and
  -- Returns reads the two as one. What came back of it is said there.
  if v_order.exchange_for_order_id is not null then
    raise exception 'Order % is an exchange: say what came back of it on Returns', v_order.order_number
      using errcode = 'check_violation', hint = 'exchange_replacement';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id
     and direction = 'outbound'
     and status <> 'cancelled'
   order by created_at desc
   limit 1
   for update;

  if v_shipment.id is null then
    raise exception 'Order % was never sent out', v_order.order_number
      using errcode = 'check_violation', hint = 'not_shipped';
  end if;

  if v_order.fulfillment_status not in ('in_transit', 'out_for_delivery', 'delivered') then
    raise exception 'Order % is not with the courier or the customer', v_order.order_number
      using errcode = 'check_violation', hint = 'not_on_the_road';
  end if;

  -- Our driver's cash comes in with it: the people who record cash.
  if v_shipment.courier = 'own'
     and v_order.fulfillment_status <> 'delivered'
     and not (public.has_permission('orders.settle') or public.is_service_request()) then
    raise exception 'Not allowed to record cash received' using errcode = 'insufficient_privilege';
  end if;

  -- Something already came back, or is said to be coming: what the customer
  -- kept is said at its check-in.
  if exists (select 1 from public.returns r where r.order_id = p_order_id) then
    raise exception 'Order % already has a return: say what the customer kept when it is checked in',
      v_order.order_number using errcode = 'check_violation', hint = 'order_has_returns';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Say which pieces of order % the customer took', v_order.order_number
      using errcode = 'invalid_parameter_value';
  end if;

  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    if not exists (select 1 from public.order_line_items li
                    where li.id = (v_item ->> 'order_line_item_id')::uuid
                      and li.order_id = p_order_id) then
      raise exception 'Line % is not on order %', v_item ->> 'order_line_item_id', v_order.order_number
        using errcode = 'foreign_key_violation';
    end if;
  end loop;

  for v_line in
    select li.sku, li.quantity, k.kept
      from public.order_line_items li
     cross join lateral (
       select coalesce(sum((e ->> 'quantity_kept')::integer), 0)::integer as kept
         from jsonb_array_elements(p_lines) e
        where (e ->> 'order_line_item_id')::uuid = li.id
     ) k
     where li.order_id = p_order_id
       and li.quantity > 0
  loop
    if v_line.kept < 0 or v_line.kept > v_line.quantity then
      raise exception 'Only % of % went out', v_line.quantity, v_line.sku
        using errcode = 'check_violation';
    end if;
    v_kept_total := v_kept_total + v_line.kept;
    v_back_total := v_back_total + v_line.quantity - v_line.kept;
  end loop;

  if v_back_total = 0 then
    raise exception 'Nothing on order % is coming back: the customer took it all', v_order.order_number
      using errcode = 'check_violation', hint = 'nothing_back';
  end if;

  if v_kept_total = 0 then
    raise exception 'The customer took nothing of order %: record it refused on Returns', v_order.order_number
      using errcode = 'check_violation', hint = 'nothing_kept';
  end if;

  insert into public.returns (
    order_id, outbound_shipment_id, type, reason, status, courier_reported_at, note
  )
  values (
    p_order_id, v_shipment.id, 'failed_delivery', p_reason, 'expected', now(), nullif(btrim(p_note), '')
  )
  returning * into v_return;

  -- Every piece that went out: what stayed, and what is coming back. A line
  -- kept whole stays as the record that it was there and stayed.
  insert into public.return_lines (
    return_id, order_line_item_id, variant_id, sku, quantity_expected, quantity_kept
  )
  select v_return.id, li.id, li.variant_id, li.sku, li.quantity - k.kept, k.kept
    from public.order_line_items li
   cross join lateral (
     select coalesce(sum((e ->> 'quantity_kept')::integer), 0)::integer as kept
       from jsonb_array_elements(p_lines) e
      where (e ->> 'order_line_item_id')::uuid = li.id
   ) k
   where li.order_id = p_order_id
     and li.quantity > 0;

  -- What is coming back, at what it sold for - the same sum the check-in makes.
  select coalesce(round(sum(public.order_line_unit_value(rl.order_line_item_id) * rl.quantity_expected), 2), 0)
    into v_value
    from public.return_lines rl
   where rl.return_id = v_return.id;

  update public.returns
     set value_egp  = v_value,
         refund_egp = case when public.return_is_refunded(p_order_id, 'failed_delivery') then v_value else 0 end
   where id = v_return.id
  returning * into v_return;

  if v_order.fulfillment_status <> 'delivered' then
    update public.shipments
       set status = 'delivered',
           delivered_at = coalesce(delivered_at, now())
     where id = v_shipment.id;

    -- The status trigger writes the history, with who did it. Our driver's
    -- cash on delivery is in, as with "cash received".
    update public.orders
       set fulfillment_status = 'delivered',
           payment_status = case
             when v_shipment.courier = 'own' and payment_method = 'cod' and payment_status = 'pending'
               then 'paid'::public.payment_status
             else payment_status
           end
     where id = p_order_id
    returning * into v_order;
  end if;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    p_order_id, 'partial_delivery', nullif(btrim(p_note), ''),
    jsonb_build_object(
      'kept', v_kept_total,
      'back', v_back_total,
      'value_egp', v_value,
      'reason', p_reason,
      'return_id', v_return.id,
      'lines', (select jsonb_agg(jsonb_build_object('sku', rl.sku, 'kept', rl.quantity_kept, 'back', rl.quantity_expected)
                                 order by rl.sku)
                  from public.return_lines rl where rl.return_id = v_return.id)
    ),
    auth.uid()
  );

  return v_return;
end;
$$;

comment on function public.record_partial_delivery(uuid, jsonb, public.return_reason, text) is
  'The customer kept some of the parcel: the order is delivered of what was kept, '
  'and a refusal at the door is opened for the rest, coming back with the courier. '
  'The refused pieces come off what is owed at once; stock comes back at check-in.';

revoke execute on function public.record_partial_delivery(uuid, jsonb, public.return_reason, text) from public, anon;
grant execute on function public.record_partial_delivery(uuid, jsonb, public.return_reason, text) to authenticated, service_role;

-- --- Taking it back -----------------------------------------------------------------------

-- As in 20261104090000, and a partial delivery pressed by mistake can be
-- taken back too, while its pieces are still on the way: nothing was counted
-- in, so nothing moved, and the refusal it opened goes with it. The order
-- goes back to the courier or driver, as any delivery undone does.
create or replace function public.undo_delivered(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders;
  v_shipment     public.shipments;
  v_back         public.fulfillment_status;
  v_delivered_at timestamptz;
  v_cleared      jsonb;
begin
  if not (public.has_permission('orders.settle')
          or public.has_permission('orders.ship')
          or public.is_service_request()) then
    raise exception 'Not allowed to change a delivery' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status <> 'delivered' or v_order.cancelled_at is not null then
    raise exception 'Order % is not delivered', v_order.order_number
      using errcode = 'check_violation', hint = 'not_delivered';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id
     and direction = 'outbound'
     and status <> 'cancelled'
   order by created_at desc
   limit 1
   for update;

  -- Sold over the counter: handed over as it was rung up, nothing to undo.
  if v_shipment.id is null then
    raise exception 'Order % was never sent out', v_order.order_number
      using errcode = 'check_violation', hint = 'not_shipped';
  end if;

  -- When it was marked delivered, and from where: the step the history
  -- recorded, or where a parcel of this kind waits - out with our driver, or
  -- with the courier.
  select e.created_at, e.from_fulfillment into v_delivered_at, v_back
    from public.order_events e
   where e.order_id = p_order_id
     and e.event_type = 'fulfillment_change'
     and e.to_fulfillment = 'delivered'
   order by e.created_at desc
   limit 1;

  -- Unknown, any payment recorded on it counts as after.
  v_delivered_at := coalesce(v_delivered_at, v_shipment.delivered_at, '-infinity');
  if v_back is null or v_back not in ('in_transit', 'out_for_delivery') then
    v_back := case when v_shipment.courier = 'own' then 'out_for_delivery' else 'in_transit' end;
  end if;

  if v_order.payment_status <> 'pending'
     and exists (select 1 from public.order_events e
                  where e.order_id = p_order_id
                    and e.event_type = 'payment_change'
                    and e.to_payment = 'paid'
                    and e.created_at >= v_delivered_at)
  then
    raise exception 'Order % was paid on delivery: reopen its payment first', v_order.order_number
      using errcode = 'check_violation', hint = 'order_paid';
  end if;

  -- Anything back but a partial delivery's refusal still on its way, with
  -- nothing of it counted in.
  if exists (select 1 from public.returns r
              where r.order_id = p_order_id
                and not (r.type = 'failed_delivery'
                         and r.status in ('expected', 'in_transit')
                         and exists (select 1 from public.return_lines k
                                      where k.return_id = r.id and k.quantity_kept > 0)
                         and not exists (select 1 from public.return_lines k
                                          where k.return_id = r.id and k.quantity_received > 0)))
     or exists (select 1 from public.returns r
                 where r.replacement_order_id = p_order_id
                   and r.status not in ('expected', 'in_transit'))
  then
    raise exception 'Order % has pieces back from the customer', v_order.order_number
      using errcode = 'check_violation', hint = 'order_has_returns';
  end if;

  if exists (select 1 from public.settlement_lines sl
              where sl.order_id = p_order_id and sl.outcome = 'delivered') then
    raise exception 'The courier''s statement says order % was delivered', v_order.order_number
      using errcode = 'check_violation', hint = 'statement_says_delivered';
  end if;

  -- The partial delivery's refusal goes with it: what it said was kept and
  -- coming back is in the history.
  select jsonb_agg(jsonb_build_object('sku', rl.sku, 'kept', rl.quantity_kept, 'back', rl.quantity_expected)
                   order by rl.sku)
    into v_cleared
    from public.return_lines rl
    join public.returns r on r.id = rl.return_id
   where r.order_id = p_order_id;

  delete from public.returns where order_id = p_order_id;

  update public.shipments
     set status       = v_back::text::public.shipment_status,
         delivered_at = null
   where id = v_shipment.id;

  -- The status trigger records the step back, with who did it.
  update public.orders
     set fulfillment_status = v_back
   where id = p_order_id
  returning * into v_order;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (p_order_id, 'delivery_undone', nullif(btrim(p_reason), ''),
          jsonb_strip_nulls(jsonb_build_object(
            'back_to', v_back,
            'tracking_number', v_shipment.tracking_number,
            'partial_cleared', v_cleared)),
          auth.uid());

  return v_order;
end;
$$;

comment on function public.undo_delivered(uuid, text) is
  'Takes back a delivery recorded by mistake: the order and its shipment go '
  'back to the courier or driver, with a partial delivery''s refusal that is '
  'still on its way. Refused once paid, once anything came back on it, or when '
  'the courier''s statement says it was delivered.';

revoke execute on function public.undo_delivered(uuid, text) from public, anon;
grant execute on function public.undo_delivered(uuid, text) to authenticated, service_role;

-- --- Where it shows -----------------------------------------------------------------------

-- As in 20261102110000, and each line says how many of it are on their way
-- back (coming_back) beside how many came back.

create or replace view public.v_order_list
with (security_invoker = on) as
SELECT o.id,
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
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_phone, c.phone) AS customer_phone,
    NULLIF(concat_ws('، '::text, NULLIF(TRIM(BOTH FROM COALESCE(o.ship_address_line1, c.address_line1)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(o.ship_address_line2, c.address_line2)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(o.ship_city, c.city)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(o.ship_governorate, c.governorate)), ''::text)), ''::text) AS customer_address,
    s.id AS shipment_id,
    s.tracking_number,
    s.courier,
    s.driver_name,
    s.status AS shipment_status,
    s.handed_over_at,
    s.delivered_at,
    s.cod_amount_egp,
    COALESCE(li.lines, '[]'::jsonb) AS items,
    COALESCE(li.unit_count, 0) AS unit_count,
        CASE
            WHEN o.cancelled_at IS NOT NULL OR o.fulfillment_status = 'cancelled'::fulfillment_status THEN 'cancelled'::text
            WHEN o.fulfillment_status = ANY (ARRAY['awaiting_confirmation'::fulfillment_status, 'confirmed'::fulfillment_status, 'ready_to_pack'::fulfillment_status, 'packed'::fulfillment_status, 'awaiting_pickup'::fulfillment_status]) THEN 'to_ship'::text
            WHEN o.fulfillment_status = ANY (ARRAY['in_transit'::fulfillment_status, 'out_for_delivery'::fulfillment_status]) THEN 'on_the_road'::text
            WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN 'delivered'::text
            ELSE 'back'::text
        END AS stage,
    COALESCE(
        CASE
            WHEN o.fulfillment_status = ANY (ARRAY['in_transit'::fulfillment_status, 'out_for_delivery'::fulfillment_status]) THEN s.handed_over_at
            ELSE NULL::timestamp with time zone
        END, ( SELECT max(e.created_at) AS max
           FROM order_events e
          WHERE e.order_id = o.id AND e.to_fulfillment = o.fulfillment_status), o.created_at) AS stage_since,
    o.shopify_order_id,
    (EXISTS ( SELECT 1
           FROM shopify_order_outbox q
          WHERE q.order_id = o.id)) AS shopify_pending,
    o.exchange_for_order_id,
    ( SELECT x.order_number
           FROM orders x
          WHERE x.id = o.exchange_for_order_id) AS exchange_for_order_number,
    o.exchange_refund_egp,
    o.exchange_refunded_at,
    ( SELECT string_agg(x.order_number, '، '::text ORDER BY x.created_at) AS string_agg
           FROM orders x
          WHERE x.exchange_for_order_id = o.id AND x.cancelled_at IS NULL) AS exchanged_in,
    o.cancelled_at IS NOT NULL OR o.fulfillment_status = 'cancelled'::fulfillment_status OR (o.fulfillment_status = ANY (ARRAY['delivered'::fulfillment_status, 'returned'::fulfillment_status])) AND (o.fulfillment_status = 'returned'::fulfillment_status OR (o.payment_status = ANY (ARRAY['paid'::payment_status, 'refunded'::payment_status, 'partially_refunded'::payment_status]))) AND NOT (o.exchange_refund_egp > 0::numeric AND o.exchange_refunded_at IS NULL) AND NOT (EXISTS ( SELECT 1
           FROM returns r
          WHERE r.order_id = o.id AND ((r.status = ANY (ARRAY['expected'::return_status, 'in_transit'::return_status, 'discrepancy'::return_status])) OR r.refund_egp > 0::numeric AND r.refunded_at IS NULL))) AS is_closed,
    COALESCE(o.ship_governorate, c.governorate) AS customer_governorate,
        CASE
            WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN order_returned_off_egp(o.id)
            ELSE 0::numeric
        END AS returned_off_egp,
    COALESCE(( SELECT sum(r.refund_egp) AS sum
           FROM returns r
          WHERE r.order_id = o.id AND r.refunded_at IS NULL), 0::numeric) AS return_refund_owed_egp,
    COALESCE(( SELECT sum(r.refund_egp) AS sum
           FROM returns r
          WHERE r.order_id = o.id AND r.refunded_at IS NOT NULL), 0::numeric) AS return_refunded_egp
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sh.id,
            sh.order_id,
            sh.courier,
            sh.tracking_number,
            sh.direction,
            sh.status,
            sh.collects_return,
            sh.zone,
            sh.subzone,
            sh.service_type,
            sh.cod_amount_egp,
            sh.handed_over_at,
            sh.delivered_at,
            sh.failed_at,
            sh.returned_at,
            sh.last_tracked_at,
            sh.note,
            sh.created_at,
            sh.updated_at,
            sh.driver_name
           FROM shipments sh
          WHERE sh.order_id = o.id AND sh.direction = 'outbound'::shipment_direction AND sh.status <> 'cancelled'::shipment_status
          ORDER BY sh.created_at DESC
         LIMIT 1) s ON true
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('sku', l.sku, 'title', l.title, 'variant_title', l.variant_title, 'quantity', l.quantity, 'unit_price_egp', l.unit_price_egp, 'total_egp', l.total_egp, 'returned', ( SELECT COALESCE(sum(rl.quantity_expected), 0::bigint) AS "coalesce"
                   FROM return_lines rl
                     JOIN returns r ON r.id = rl.return_id
                  WHERE rl.order_line_item_id = l.id AND r.type <> 'exchange'::return_type AND (r.status = ANY (ARRAY['received'::return_status, 'discrepancy'::return_status, 'closed'::return_status]))), 'coming_back', ( SELECT COALESCE(sum(rl.quantity_expected), 0::bigint) AS "coalesce"
                   FROM return_lines rl
                     JOIN returns r ON r.id = rl.return_id
                  WHERE rl.order_line_item_id = l.id AND r.type <> 'exchange'::return_type AND (r.status = ANY (ARRAY['expected'::return_status, 'in_transit'::return_status])))) ORDER BY l.created_at) AS lines,
            sum(l.quantity)::integer AS unit_count
           FROM order_line_items l
          WHERE l.order_id = o.id) li ON true
  WHERE o.archived_at IS NULL;

-- As in 20261102110000, naming only what is coming back: a line the customer
-- kept whole is on the return as a record, not as something to look for.

create or replace view public.v_returns_inbound
with (security_invoker = on) as
SELECT r.id AS return_id,
    r.type,
    r.reason,
    r.status,
    r.courier_reported_at,
    o.id AS order_id,
    o.order_number,
    o.payment_method,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_phone, c.phone) AS customer_phone,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    s.tracking_number,
    EXTRACT(epoch FROM now() - COALESCE(r.courier_reported_at, r.created_at)) / 86400::numeric AS days_since_reported,
    ( SELECT COALESCE(sum(rl.quantity_expected), 0::bigint) AS "coalesce"
           FROM return_lines rl
          WHERE rl.return_id = r.id) AS units_expected,
    ( SELECT string_agg((rl.sku || ' x'::text) || rl.quantity_expected, ', '::text ORDER BY rl.created_at) AS string_agg
           FROM return_lines rl
          WHERE rl.return_id = r.id AND rl.quantity_expected > 0) AS items
   FROM returns r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sh.tracking_number
           FROM shipments sh
          WHERE sh.id = r.outbound_shipment_id OR r.type = 'exchange'::return_type AND sh.order_id = r.replacement_order_id AND sh.direction = 'outbound'::shipment_direction
          ORDER BY sh.created_at DESC
         LIMIT 1) s ON true
  WHERE r.status = ANY (ARRAY['expected'::return_status, 'in_transit'::return_status]);
