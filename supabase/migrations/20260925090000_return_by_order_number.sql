-- ---------------------------------------------------------------------------
-- A return that never went near a courier.
--
-- Not everything Duch sells is shipped: a shop sale is handed over and born
-- delivered (create_store_sale and the store branch of create_manual_order
-- both set fulfillment_status = 'delivered' outright), so it has no shipment
-- and no tracking code. Until now the only way into the check-in screen was
-- scanning that code, which meant a customer walking back into the shop with
-- something bought there had no way to be processed at all.
--
-- lookup_return_by_order_number mirrors lookup_return_by_tracking, but
-- starts from the order number every channel has instead of a tracking
-- number only a courier-shipped order gets. A delivered order with no open
-- return gets the same self-service treatment record_delivery_failure gives
-- an unrecorded courier failure: the screen offers to record it and check it
-- in as one action, because the reason for a counter return can only be
-- known at the counter, not before.
-- ---------------------------------------------------------------------------

create or replace function public.lookup_return_by_order_number(p_order_number text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_customer public.customers;
  v_shipment public.shipments;
  v_return   public.returns;
  v_lines    jsonb;
begin
  if public.auth_role() is null and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order
    from public.orders
   where upper(trim(order_number)) = upper(trim(p_order_number));

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
$$;

comment on function public.lookup_return_by_order_number is
  'Everything the check-in screen needs from an order number, for a return '
  'that has no courier tracking code because the order was never shipped.';

revoke execute on function public.lookup_return_by_order_number(text) from public, anon;
grant execute on function public.lookup_return_by_order_number(text) to authenticated, service_role;

-- --- Recording a counter return, one step before checking it in ------------
--
-- Deliberately narrower than record_delivery_failure: this is for something
-- the customer is handing back right now, so there is nothing to mark as
-- in transit and no shipment to update. receive_return, called immediately
-- after by the same screen, is what actually credits stock - this function
-- only creates the return and its lines for that call to fill in.

create or replace function public.start_post_delivery_return(
  p_order_id uuid,
  p_reason   public.return_reason,
  p_note     text default null
)
returns public.returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_shipment public.shipments;
  v_return   public.returns;
  v_line     record;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
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
$$;

comment on function public.start_post_delivery_return is
  'Creates the return and its lines for something a customer is handing '
  'back directly. Nothing here is in transit and no shipment changes - '
  'receive_return, called right after, is what credits stock.';

revoke execute on function public.start_post_delivery_return(uuid, public.return_reason, text) from public, anon;
grant execute on function public.start_post_delivery_return(uuid, public.return_reason, text) to authenticated, service_role;
