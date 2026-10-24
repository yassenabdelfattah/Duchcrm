-- A refused website order checked in on Returns is closed in Shopify by itself.
--
-- The owner closed them by hand - cancelling the Shopify order once the parcel
-- was back (2026-10-24). Now the check-in queues that cancel, through the same
-- shopify_order_outbox as a cancel made in the CRM: no restock in Shopify, no
-- email. Shopify's orders/cancelled then lands on an order already returned and
-- only writes to its history (20261024090000), and its orders/updated is left
-- alone (20261024100000). Refusals only, and unpaid only: a return after
-- delivery, an exchange, or an order paid online stay the owner's call.

-- As in 20261021090000, plus the queue at the end.
CREATE OR REPLACE FUNCTION public.receive_return(p_return_id uuid, p_lines jsonb, p_note text DEFAULT NULL::text)
 RETURNS returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_return     public.returns;
  v_order      public.orders;
  v_item       jsonb;
  v_line       public.return_lines;
  v_resellable integer;
  v_damaged    integer;
  v_delta      integer;
  v_movements  jsonb := '[]'::jsonb;
  v_missing    integer := 0;
  v_total_back integer := 0;
begin
  if not (public.has_permission('returns.manage') or public.is_service_request()) then
    raise exception 'You may not check in a return' using errcode = 'insufficient_privilege';
  end if;

  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'Return % not found', p_return_id using errcode = 'no_data_found';
  end if;

  -- Closed means somebody decided it was finished, shortfall and all.
  if v_return.status = 'closed' then
    return v_return;
  end if;

  select * into v_order from public.orders where id = v_return.order_id;

  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_line
      from public.return_lines
     where id = (v_item ->> 'return_line_id')::uuid
       and return_id = p_return_id;

    if not found then
      raise exception 'Return line % does not belong to return %',
        v_item ->> 'return_line_id', p_return_id
        using errcode = 'foreign_key_violation';
    end if;

    v_resellable := coalesce((v_item ->> 'quantity_resellable')::integer, 0);
    v_damaged    := coalesce((v_item ->> 'quantity_damaged')::integer, 0);

    -- Only the change since last time. This is what makes a second check-in
    -- safe rather than a way to invent stock.
    v_delta := v_resellable - v_line.quantity_resellable;

    update public.return_lines
       set quantity_received   = v_resellable + v_damaged,
           quantity_resellable = v_resellable,
           quantity_damaged    = v_damaged,
           condition_note      = coalesce(v_item ->> 'condition_note', condition_note)
     where id = v_line.id;

    if v_delta <> 0 then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_line.variant_id,
        'quantity_delta', v_delta
      );
    end if;
  end loop;

  select coalesce(sum(quantity_missing), 0), coalesce(sum(quantity_resellable), 0)
    into v_missing, v_total_back
    from public.return_lines where return_id = p_return_id;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'return',
      p_movements       => v_movements,
      p_reference_type  => 'return',
      p_reference_id    => p_return_id::text,
      p_note            => p_note,
      -- Keyed on the running total rather than the return alone, so a
      -- double-tapped confirm does nothing while a genuine correction applies.
      p_idempotency_key => 'return:' || p_return_id::text || ':' || v_total_back::text
    );
  end if;

  update public.returns
     set status      = case when v_missing > 0 then 'discrepancy'::public.return_status
                            else 'received'::public.return_status end,
         received_at = coalesce(received_at, now()),
         received_by = coalesce(received_by, auth.uid()),
         note        = coalesce(p_note, note)
   where id = p_return_id
  returning * into v_return;

  -- An exchange's old piece coming back does not undo the sale: the
  -- customer kept the deal, with a different piece, and the original order's
  -- money stands. Only a plain return closes the order.
  if v_return.type <> 'exchange' then
    update public.orders
       set fulfillment_status = 'returned'
     where id = v_return.order_id
       and fulfillment_status <> 'returned';

    if v_return.outbound_shipment_id is not null then
      update public.shipments
         set status = 'returned', returned_at = coalesce(returned_at, now())
       where id = v_return.outbound_shipment_id;
    end if;
  end if;

  -- A website order refused at the door and now back on the table: closed in
  -- Shopify too, the way the owner closed them by hand - cancelled, nothing
  -- restocked there (this check-in is what put the pieces back, and the CRM
  -- tells Shopify its numbers), no email. Only unpaid: cancelling an order
  -- paid online means deciding its refund, which is Shopify's screen.
  if v_return.type = 'failed_delivery'
     and v_order.shopify_order_id is not null
     and v_order.payment_status <> 'paid'
  then
    perform public.queue_shopify_order_sync(v_order.id, 'cancel');
  end if;

  return v_return;
end;
$function$;
