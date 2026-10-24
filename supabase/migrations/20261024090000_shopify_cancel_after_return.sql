-- A returned order closed in Shopify must not put its stock back again.
--
-- The owner closes Shopify orders by hand once their money is settled; a
-- refused or returned cash-on-delivery order is closed by cancelling it. The
-- orders/cancelled that sends reached cancel_order, which put every piece
-- back - pieces the returns check-in had already put back. #1418 and #1420
-- were one cancellation away from it on 2026-10-24; none had happened.
--
-- Now a Shopify cancellation of an order refused, on its way back or back is
-- recorded in the order's history and changes nothing else, and cancel_order
-- itself refuses such an order from any path: its goods come back through the
-- returns check-in, not a status change.

-- As in 20261015090100, plus the first check.
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

  -- Back, or on its way back, and cancelled in Shopify to close it there -
  -- which is how a refused cash-on-delivery order gets closed. Nothing to do
  -- here: the order is closed by its return, and its stock comes back at the
  -- check-in. Treating it as a cancellation put the pieces back twice.
  if v_order.fulfillment_status in ('delivery_failed', 'return_in_transit', 'returned') then
    insert into public.order_events (order_id, event_type, note, details)
    values (v_order.id, 'shopify_closed_after_return', p_reason, jsonb_build_object('fulfillment_status', v_order.fulfillment_status));
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

-- As in 20261021090000, plus the refusal for an order coming back.
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

  -- Refused, on its way back, or back: the goods come back at the returns
  -- check-in, which is where its stock returns. Cancelling as well would put
  -- the same pieces back twice.
  if v_order.fulfillment_status in ('delivery_failed', 'return_in_transit', 'returned') then
    raise exception 'Order % is coming back or already back. Its stock returns when it is checked in.',
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

  -- A replacement called off: the old piece is not coming back for it.
  if v_order.exchange_for_order_id is not null then
    update public.returns
       set status = 'closed',
           note   = concat_ws(E'\n', note, 'Exchange cancelled')
     where replacement_order_id = p_order_id
       and type = 'exchange'
       and status in ('expected', 'in_transit');
  end if;

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
