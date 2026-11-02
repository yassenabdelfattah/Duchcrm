-- One piece of an order can come back while the customer keeps the rest
-- (2026-11-02).
--
-- A return expected everything on the order. When a customer kept two hoodies
-- and sent one back, the two showed as missing - lost by the courier - the
-- return stayed open on the short list, the whole order turned "returned" and
-- with it "nothing owed", and the reports took all three off the sales. The
-- owner asked for it to work on one piece, both ways it happens:
--
--   at the door   the customer keeps some and the courier brings the rest back.
--                 The order is delivered - of what was kept - and the courier
--                 collects for that alone: the refused pieces come off what is
--                 owed and off what the statement should say.
--   afterwards    a delivered customer brings or sends one piece back. Having
--                 paid, they are owed its price back (after the order's
--                 discount, never the shipping) until someone records paying
--                 it, as an exchange's difference is (#13). A customer who has
--                 not paid yet - a tab - simply owes less.
--
-- At check-in each line now has a third count beside good and damaged: what
-- stayed with the customer. That comes off what is expected back, so nothing
-- the customer kept is ever counted missing. Only when every piece has come
-- back is the order returned; otherwise it stays delivered. An exchange's old
-- piece is untouched by all of this - its money is the exchange's.
--
-- Returns checked in before today keep no value and owe no refund: whatever
-- was paid back for them was settled outside the CRM.

-- --- What stayed with the customer ------------------------------------------------------

alter table public.return_lines
  add column quantity_kept integer not null default 0 check (quantity_kept >= 0);

comment on column public.return_lines.quantity_kept is
  'Pieces of this line the customer kept: they are not coming back and are not '
  'missing. Already taken off quantity_expected, so what went out is the two together.';

-- A line the customer kept whole expects nothing back. It stays, as the record
-- that the piece was there and stayed.
alter table public.return_lines drop constraint return_lines_quantity_expected_check;
alter table public.return_lines
  add constraint return_lines_quantity_expected_check check (quantity_expected >= 0);

-- --- What it was worth, and what is owed back -------------------------------------------

alter table public.returns
  add column value_egp   numeric(12, 2) not null default 0,
  add column refund_egp  numeric(12, 2) not null default 0,
  add column refunded_at timestamptz,
  add column refunded_by uuid references public.staff (id) on delete set null;

comment on column public.returns.value_egp is
  'What the pieces coming back sold for, after the order''s discount and without '
  'shipping. Set at check-in. 0 on an exchange, and on returns checked in before 2026-11-02.';
comment on column public.returns.refund_egp is
  'Of value_egp, what the customer had already paid and is owed back. The rest '
  'comes off what the order still owes.';

-- One piece of a line at what it sold for: its own discount and its share of
-- the order's taken off. The same sum the reports value a return at.
create or replace function public.order_line_unit_value(p_line_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when li.quantity > 0
              then li.total_egp
                   * case when o.subtotal_egp > 0 then o.total_egp / o.subtotal_egp else 1 end
                   / li.quantity
              else 0 end
    from public.order_line_items li
    join public.orders o on o.id = li.order_id
   where li.id = p_line_id;
$$;

-- Whether the customer has paid for what they are sending back, so it is owed
-- to them rather than taken off what they owe. Paid in the CRM; or, after
-- delivery, a cash parcel the courier collected at the door - paid by the
-- customer even while the courier still holds the cash. A refusal at the door
-- paid nothing for what it refused.
create or replace function public.return_is_refunded(p_order_id uuid, p_type public.return_type)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_type <> 'exchange'
     and (
       o.payment_status = 'paid'
       or (p_type = 'post_delivery' and exists (
             select 1 from public.shipments sh
              where sh.order_id = o.id
                and sh.direction = 'outbound'
                and sh.status <> 'cancelled'
                and sh.courier <> 'own'
                and sh.cod_amount_egp > 0))
     )
    from public.orders o
   where o.id = p_order_id;
$$;

-- What has come off the order's bill: pieces back that the customer never paid
-- for. On a delivered order, what is owed is the order less this.
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
     and r.status in ('received', 'discrepancy', 'closed');
$$;

-- How many of a line are still with the customer: what went out less every
-- piece already coming or come back, an exchange's old piece included.
create or replace function public.order_line_remaining(p_line_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select li.quantity - coalesce((
           select sum(rl.quantity_expected)
             from public.return_lines rl
            where rl.order_line_item_id = li.id
         ), 0)::integer
    from public.order_line_items li
   where li.id = p_line_id;
$$;

-- Pieces of a line the customer refused at the door, once checked in.
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
     and r.status in ('received', 'discrepancy', 'closed');
$$;

revoke execute on function public.order_line_unit_value(uuid) from public, anon;
grant execute on function public.order_line_unit_value(uuid) to authenticated, service_role;
revoke execute on function public.return_is_refunded(uuid, public.return_type) from public, anon;
grant execute on function public.return_is_refunded(uuid, public.return_type) to authenticated, service_role;
revoke execute on function public.order_returned_off_egp(uuid) from public, anon;
grant execute on function public.order_returned_off_egp(uuid) to authenticated, service_role;
revoke execute on function public.order_line_remaining(uuid) from public, anon;
grant execute on function public.order_line_remaining(uuid) to authenticated, service_role;
revoke execute on function public.order_line_refused(uuid) from public, anon;
grant execute on function public.order_line_refused(uuid) to authenticated, service_role;

-- --- Checking it in ---------------------------------------------------------------------

-- As in 20261024110000, plus what the customer kept, the value and refund, and
-- an order that is only part back staying delivered.
create or replace function public.receive_return(p_return_id uuid, p_lines jsonb, p_note text default null)
returns public.returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_return     public.returns;
  v_order      public.orders;
  v_item       jsonb;
  v_line       public.return_lines;
  v_resellable integer;
  v_damaged    integer;
  v_kept       integer;
  v_sent       integer;
  v_delta      integer;
  v_movements  jsonb := '[]'::jsonb;
  v_missing    integer := 0;
  v_total_back integer := 0;
  v_value      numeric(12, 2);
  v_all_back   boolean;
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
    -- An exchange's old piece is the one piece the exchange was for: none of
    -- it stays with the customer.
    v_kept := case when v_return.type = 'exchange' then 0
                   else coalesce((v_item ->> 'quantity_kept')::integer, v_line.quantity_kept) end;
    -- What went out on this line, however it was split before - so a second
    -- check-in corrects the first rather than taking the kept pieces off twice.
    v_sent := v_line.quantity_expected + v_line.quantity_kept;

    if v_resellable < 0 or v_damaged < 0 or v_kept < 0
       or v_resellable + v_damaged + v_kept > v_sent then
      raise exception 'More of % counted than went out: % sent', v_line.sku, v_sent
        using errcode = 'check_violation';
    end if;

    -- Only the change since last time. This is what makes a second check-in
    -- safe rather than a way to invent stock.
    v_delta := v_resellable - v_line.quantity_resellable;

    update public.return_lines
       set quantity_kept       = v_kept,
           quantity_expected   = v_sent - v_kept,
           quantity_received   = v_resellable + v_damaged,
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

  -- Kept, all of it: that is a delivery, not a return.
  if not exists (
    select 1 from public.return_lines where return_id = p_return_id and quantity_expected > 0
  ) then
    raise exception 'Nothing on order % is coming back - the customer kept it all',
      v_order.order_number using errcode = 'check_violation';
  end if;

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

  -- What is coming back, at what it sold for: everything expected, the
  -- missing included - the courier answers for those, not the customer.
  select coalesce(round(sum(public.order_line_unit_value(rl.order_line_item_id) * rl.quantity_expected), 2), 0)
    into v_value
    from public.return_lines rl
   where rl.return_id = p_return_id;

  update public.returns
     set status      = case when v_missing > 0 then 'discrepancy'::public.return_status
                            else 'received'::public.return_status end,
         received_at = coalesce(received_at, now()),
         received_by = coalesce(received_by, auth.uid()),
         note        = coalesce(p_note, note),
         value_egp   = case when type = 'exchange' then 0 else v_value end,
         -- Once paid back it stays what was paid.
         refund_egp  = case
                         when refunded_at is not null then refund_egp
                         when public.return_is_refunded(order_id, type) then v_value
                         else 0
                       end
   where id = p_return_id
  returning * into v_return;

  -- An exchange's old piece coming back does not undo the sale: the
  -- customer kept the deal, with a different piece, and the original order's
  -- money stands. Only a plain return closes the order - and only once every
  -- piece is back. An exchanged piece counts as still sold.
  if v_return.type <> 'exchange' then
    v_all_back := not exists (
      select 1
        from public.order_line_items li
       where li.order_id = v_order.id
         and li.quantity > coalesce((
               select sum(rl.quantity_expected)
                 from public.return_lines rl
                 join public.returns r on r.id = rl.return_id
                where rl.order_line_item_id = li.id
                  and r.type <> 'exchange'
             ), 0)
    );

    if v_all_back then
      update public.orders
         set fulfillment_status = 'returned'
       where id = v_return.order_id
         and fulfillment_status <> 'returned';

      if v_return.outbound_shipment_id is not null then
        update public.shipments
           set status = 'returned', returned_at = coalesce(returned_at, now())
         where id = v_return.outbound_shipment_id;
      end if;
    else
      -- The customer has the rest: refused only in part at the door, the
      -- parcel was delivered - of what they kept. The status trigger writes
      -- the history.
      update public.orders
         set fulfillment_status = 'delivered'
       where id = v_return.order_id
         and fulfillment_status <> 'delivered';

      if v_return.outbound_shipment_id is not null then
        update public.shipments
           set status = 'delivered', delivered_at = coalesce(delivered_at, now())
         where id = v_return.outbound_shipment_id
           and status not in ('delivered', 'cancelled');
      end if;
    end if;
  end if;

  -- A website order refused at the door and now back on the table: closed in
  -- Shopify too, the way the owner closed them by hand - cancelled, nothing
  -- restocked there (this check-in is what put the pieces back, and the CRM
  -- tells Shopify its numbers), no email. Only unpaid: cancelling an order
  -- paid online means deciding its refund, which is Shopify's screen. Only
  -- the whole of it: an order the customer kept part of is not cancelled.
  if v_return.type = 'failed_delivery'
     and v_all_back
     and v_order.shopify_order_id is not null
     and v_order.payment_status <> 'paid'
  then
    perform public.queue_shopify_order_sync(v_order.id, 'cancel');
  end if;

  return v_return;
end;
$$;

revoke execute on function public.receive_return(uuid, jsonb, text) from public, anon;
grant execute on function public.receive_return(uuid, jsonb, text) to authenticated, service_role;

-- --- Paying it back -----------------------------------------------------------------------

create or replace function public.mark_return_refunded(p_order_id uuid, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders;
  v_amount numeric(12, 2);
begin
  if not (public.has_permission('orders.settle') or public.is_service_request()) then
    raise exception 'You may not record money paid' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  select coalesce(sum(refund_egp), 0) into v_amount
    from public.returns
   where order_id = p_order_id and refund_egp > 0 and refunded_at is null;

  if v_amount <= 0 then
    raise exception 'Nothing is owed back on order %', v_order.order_number
      using errcode = 'check_violation';
  end if;

  update public.returns
     set refunded_at = now(),
         refunded_by = auth.uid()
   where order_id = p_order_id and refund_egp > 0 and refunded_at is null;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (p_order_id, 'return_refunded', p_note,
          jsonb_build_object('amount_egp', v_amount), auth.uid());

  return v_order;
end;
$$;

revoke execute on function public.mark_return_refunded(uuid, text) from public, anon;
grant execute on function public.mark_return_refunded(uuid, text) to authenticated, service_role;

-- --- Starting a return after delivery -----------------------------------------------------

-- As in 20261005090000, but for what is still with the customer: a piece that
-- already came back is not expected again, and one return checked in does not
-- stop the next.
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
  if not (public.has_permission('returns.manage') or public.is_service_request()) then
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

  if exists (
    select 1 from public.returns
     where order_id = p_order_id and status in ('expected', 'in_transit')
  ) then
    raise exception 'Order % already has an open return', v_order.order_number
      using errcode = 'unique_violation';
  end if;

  if not exists (
    select 1 from public.order_line_items li
     where li.order_id = p_order_id and public.order_line_remaining(li.id) > 0
  ) then
    raise exception 'Everything on order % has already come back', v_order.order_number
      using errcode = 'check_violation';
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

  -- Everything still with the customer, for the check-in to say what came
  -- back and what they kept.
  for v_line in
    select li.id, li.variant_id, li.sku, public.order_line_remaining(li.id) as remaining
      from public.order_line_items li
     where li.order_id = p_order_id
  loop
    if v_line.remaining > 0 then
      insert into public.return_lines (
        return_id, order_line_item_id, variant_id, sku, quantity_expected
      )
      values (v_return.id, v_line.id, v_line.variant_id, v_line.sku, v_line.remaining);
    end if;
  end loop;

  return v_return;
end;
$$;

revoke execute on function public.start_post_delivery_return(uuid, public.return_reason, text) from public, anon;
grant execute on function public.start_post_delivery_return(uuid, public.return_reason, text) to authenticated, service_role;

-- --- Finding it on Returns ----------------------------------------------------------------

-- A return's lines, each with the order line it is for - the screen matches
-- counts to lines by it, not by position - what was kept and what one piece
-- sold for.
create or replace function public.return_lines_json(p_return_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'return_line_id', rl.id,
           'order_line_item_id', rl.order_line_item_id,
           'sku', rl.sku,
           'variant_id', rl.variant_id,
           'title', li.title,
           'variant_title', li.variant_title,
           'quantity_expected', rl.quantity_expected,
           'quantity_kept', rl.quantity_kept,
           'quantity_received', rl.quantity_received,
           'quantity_resellable', rl.quantity_resellable,
           'quantity_damaged', rl.quantity_damaged,
           'unit_value_egp', round(coalesce(public.order_line_unit_value(rl.order_line_item_id), 0), 2)
         ) order by li.created_at, rl.sku), '[]'::jsonb)
    from public.return_lines rl
    left join public.order_line_items li on li.id = rl.order_line_item_id
   where rl.return_id = p_return_id;
$$;

-- What is still with the customer, line by line - all of it before anything
-- has come back.
create or replace function public.order_lines_json(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_line_item_id', li.id,
           'sku', li.sku,
           'title', li.title,
           'variant_title', li.variant_title,
           'quantity', public.order_line_remaining(li.id),
           'unit_value_egp', round(coalesce(public.order_line_unit_value(li.id), 0), 2)
         ) order by li.created_at, li.sku), '[]'::jsonb)
    from public.order_line_items li
   where li.order_id = p_order_id
     and public.order_line_remaining(li.id) > 0;
$$;

revoke execute on function public.return_lines_json(uuid) from public, anon;
grant execute on function public.return_lines_json(uuid) to authenticated, service_role;
revoke execute on function public.order_lines_json(uuid) from public, anon;
grant execute on function public.order_lines_json(uuid) to authenticated, service_role;

-- As in 20261021090000, with the lines above and whether what comes back is
-- owed back to the customer.
create or replace function public.lookup_return_by_tracking(p_tracking text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_return   public.returns;
  v_customer public.customers;
  v_state    text;
begin
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('state', 'not_found', 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Or the exchange whose replacement went out in this parcel: the courier
  -- collected the old piece on the same visit.
  select * into v_return
    from public.returns
   where outbound_shipment_id = v_shipment.id
      or (type = 'exchange' and replacement_order_id = v_shipment.order_id)
   order by created_at desc
   limit 1;

  v_state := case
    -- Fully accounted for. Scanning it again says so rather than inviting a
    -- second count of the same parcel.
    when v_return.id is not null and v_return.status in ('received', 'closed')
      then 'already_received'
    -- A return still marked short stays open on purpose: the missing piece
    -- may turn up next week, and it should be recordable when it does.
    -- receive_return only ever moves the difference, so scanning a short
    -- parcel again cannot add the same garments to stock twice.
    when v_return.id is not null then 'ready_to_receive'
    -- The parcel is on the table but nobody recorded the failure when the
    -- courier rang. Rather than making someone go and do that first, the
    -- screen offers to record it and check it in as one action.
    when v_order.fulfillment_status in ('in_transit', 'out_for_delivery',
                                        'delivery_failed', 'return_in_transit')
      then 'needs_failure_record'
    else 'not_returnable'
  end;

  return jsonb_build_object(
    'state', v_state,
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
    'exchange', case when v_return.type = 'exchange' then jsonb_build_object(
      'original_order_number', (select x.order_number from public.orders x where x.id = v_return.order_id),
      'replacement_order_number', (select x.order_number from public.orders x where x.id = v_return.replacement_order_id)
    ) end,
    -- What comes back is owed to the customer rather than taken off the bill.
    'refunded', public.return_is_refunded(
      coalesce(v_return.order_id, v_order.id),
      coalesce(v_return.type, 'failed_delivery'::public.return_type)
    ),
    'lines', public.return_lines_json(v_return.id),
    -- What went out, for the case where no return exists yet and the screen
    -- has to show the packer what to expect in the parcel.
    'order_lines', public.order_lines_json(v_order.id)
  );
end;
$$;

-- As in 20261021090000. A delivered order with pieces still at the customer's
-- can be returned again after a return that took only some.
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
  v_state    text;
  v_type     public.return_type;
begin
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order
    from public.orders
   where upper(trim(order_number)) in (
           upper(trim(p_order_number)),
           '#' || upper(trim(p_order_number))
         );

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

  -- Typed as the replacement's number, it is that exchange's old piece -
  -- not a fresh return of the replacement.
  select * into v_return
    from public.returns
   where order_id = v_order.id
      or (type = 'exchange' and replacement_order_id = v_order.id)
   order by created_at desc
   limit 1;

  v_state := case
    -- Back, but the customer still has pieces of a delivered order: those can
    -- come back too.
    when v_return.id is not null and v_return.status in ('received', 'closed')
         and v_order.fulfillment_status = 'delivered'
         and exists (select 1 from public.order_line_items li
                      where li.order_id = v_order.id and public.order_line_remaining(li.id) > 0)
      then 'needs_post_delivery_record'
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
  end;

  -- The return this will be, for whether its value is owed back.
  v_type := case v_state
    when 'ready_to_receive' then v_return.type
    when 'needs_post_delivery_record' then 'post_delivery'
    else 'failed_delivery'
  end;

  return jsonb_build_object(
    'state', v_state,
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
      when v_return.id is null or v_state = 'needs_post_delivery_record' then null
      else jsonb_build_object(
        'id', v_return.id,
        'type', v_return.type,
        'reason', v_return.reason,
        'status', v_return.status
      )
    end,
    'exchange', case when v_return.type = 'exchange' and v_state <> 'needs_post_delivery_record'
      then jsonb_build_object(
        'original_order_number', (select x.order_number from public.orders x where x.id = v_return.order_id),
        'replacement_order_number', (select x.order_number from public.orders x where x.id = v_return.replacement_order_id)
      ) end,
    'refunded', public.return_is_refunded(coalesce(v_return.order_id, v_order.id), v_type),
    'lines', case when v_state = 'ready_to_receive' then public.return_lines_json(v_return.id)
                  else '[]'::jsonb end,
    'order_lines', public.order_lines_json(v_order.id)
  );
end;
$$;

-- --- What is owed, and what the courier should have collected -----------------------------

-- As in 20261026100000, less what the customer refused at the door: the
-- courier collected only for what was kept.
create or replace function public.settlement_goods(p_shipment_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when sh.cod_amount_egp = 0 then 0
           when o.fulfillment_status = 'delivered' then o.total_egp - public.order_returned_off_egp(o.id)
           else o.total_egp
         end
    from public.shipments sh
    join public.orders o on o.id = sh.order_id
   where sh.id = p_shipment_id;
$$;

-- As in 20261027090000, with the goods less what was refused.
create or replace view public.v_settlement_breakdown as
select
  sl.settlement_id,
  coalesce(sum(g.goods_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0) as goods_egp,
  coalesce(sum(sl.collected_egp), 0) as collected_egp,
  coalesce(sum(sl.fee_egp), 0) as fees_egp,
  coalesce(sum(sl.net_egp), 0) as net_egp,
  -- What the courier says they collected, against what the goods and the
  -- shipping were worth. Anything other than zero means a parcel was collected
  -- for the wrong amount, which is worth seeing rather than averaging away.
  coalesce(sum(sl.collected_egp), 0)
    - coalesce(sum(g.goods_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    - coalesce(sum(sl.customer_shipping_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    as collection_difference_egp,
  coalesce(sum(sl.customer_shipping_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    as customer_shipping_egp
from public.settlement_lines sl
left join public.orders o on o.id = sl.order_id
cross join lateral (
  select o.total_egp
         - case when o.fulfillment_status = 'delivered' then public.order_returned_off_egp(o.id) else 0 end
           as goods_egp
) g
group by sl.settlement_id;

-- As in 20261026100000, without the pieces refused at the door.
create or replace view public.v_settlement_products
with (security_invoker = on) as
select
  sl.settlement_id,
  li.title,
  li.unit_price_egp,
  sum(li.quantity - r.refused)::integer as quantity,
  sum(round(li.total_egp * (li.quantity - r.refused) / li.quantity, 2)) as total_egp
from public.settlement_lines sl
join public.orders o on o.id = sl.order_id
join public.order_line_items li on li.order_id = sl.order_id
cross join lateral (
  select case when o.fulfillment_status = 'delivered' then public.order_line_refused(li.id) else 0 end
           as refused
) r
-- Only the deliveries. A refused parcel brought no money in; it appears among
-- the deductions instead. Nor did one paid online.
where sl.outcome = 'delivered'
  and sl.collected_egp > 0
  and li.quantity > r.refused
group by sl.settlement_id, li.title, li.unit_price_egp;

-- As in 20261027090000, the goods less what was refused.
create or replace function public.lookup_shipment_for_settlement(p_tracking text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_customer public.customers;
  v_settled  record;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may read settlements'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('found', false, 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Already on a statement. Worth knowing before it is keyed a second time.
  select s.reference, s.id into v_settled
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.order_id = v_order.id
   limit 1;

  return jsonb_build_object(
    'found', true,
    'tracking_number', v_shipment.tracking_number,
    'order_number', v_order.order_number,
    'fulfillment_status', v_order.fulfillment_status,
    'payment_status', v_order.payment_status,
    'payment_method', v_order.payment_method,
    'prepaid', v_shipment.cod_amount_egp = 0,
    'customer_name', v_customer.full_name,
    'governorate', v_customer.governorate,
    'goods_egp', v_order.total_egp
                 - case when v_order.fulfillment_status = 'delivered'
                        then public.order_returned_off_egp(v_order.id) else 0 end,
    'shipping_egp', v_order.shipping_egp,
    -- What their statement should say for it, delivered: collected at the
    -- door, and charged to carry it - the shipping the customer was charged.
    'expected_egp', public.settlement_goods(v_shipment.id) + public.settlement_door_shipping(v_shipment.id),
    'door_shipping_egp', public.settlement_door_shipping(v_shipment.id),
    'fee_egp', v_order.shipping_egp,
    'already_on', v_settled.reference,
    -- What the customer took: a piece refused at the door is not on it.
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity - r.refused,
               'unit_price_egp', li.unit_price_egp,
               'total_egp', round(li.total_egp * (li.quantity - r.refused) / li.quantity, 2)
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       cross join lateral (
         select case when v_order.fulfillment_status = 'delivered'
                     then public.order_line_refused(li.id) else 0 end as refused
       ) r
       where li.order_id = v_order.id
         and li.quantity > r.refused
    )
  );
end;
$$;

-- --- Once pieces are back, the basket is closed ---------------------------------------------

-- As in 20261003090000, and closed too once any piece has come back:
-- editing the basket would move stock the return already put back.
create or replace function public.assert_order_money_editable(p_order public.orders)
returns void
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_order.cancelled_at is not null then
    raise exception 'Order % was cancelled and cannot be edited', p_order.order_number
      using errcode = 'check_violation', hint = 'order_cancelled';
  end if;

  if p_order.fulfillment_status in ('returned', 'return_in_transit') then
    raise exception
      'Order % was returned. Its money and items are closed - only the note can be changed.',
      p_order.order_number
      using errcode = 'check_violation', hint = 'order_returned';
  end if;

  if exists (
    select 1 from public.returns r
      join public.return_lines rl on rl.return_id = r.id
     where r.order_id = p_order.id and r.type <> 'exchange' and rl.quantity_expected > 0
  ) then
    raise exception
      'Order % has pieces back from the customer. Its money and items are closed - only the note can be changed.',
      p_order.order_number
      using errcode = 'check_violation', hint = 'order_returned';
  end if;

  if p_order.payment_status = 'paid' then
    raise exception
      'Order % has been paid for. Its money cannot be changed - record a return or a refund instead.',
      p_order.order_number
      using errcode = 'restrict_violation', hint = 'order_already_paid';
  end if;

  if exists (select 1 from public.settlement_lines where order_id = p_order.id) then
    raise exception
      'Order % is on a courier statement and its money has already been counted.',
      p_order.order_number
      using errcode = 'restrict_violation', hint = 'order_on_settlement';
  end if;
end;
$$;

-- --- The orders list ------------------------------------------------------------------------

-- As in 20261023090000. Each line says how many came back; appended at the
-- end, what came off the bill and what is owed back; and an order with money
-- owed back to the customer is not finished.
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
                             as exchanged_in,
  -- Appended for the archive tab: nothing left to do on it. Cancelled; or
  -- delivered with the money in and nothing owed back; or returned with
  -- the parcel checked in. A return still on its way keeps it open either way.
  (
    o.cancelled_at is not null
    or o.fulfillment_status = 'cancelled'
    or (
      o.fulfillment_status in ('delivered', 'returned')
      and (o.fulfillment_status = 'returned'
           or o.payment_status in ('paid', 'refunded', 'partially_refunded'))
      and not (o.exchange_refund_egp > 0 and o.exchange_refunded_at is null)
      and not exists (
        select 1 from public.returns r
         where r.order_id = o.id
           and (r.status in ('expected', 'in_transit', 'discrepancy')
                or (r.refund_egp > 0 and r.refunded_at is null))
      )
    )
  )                          as is_closed,
  c.governorate              as customer_governorate,
  -- Appended for a return of part of it: what came off the bill - pieces
  -- back the customer had not paid for - and what is owed back to them.
  case when o.fulfillment_status = 'delivered' then public.order_returned_off_egp(o.id) else 0 end
                             as returned_off_egp,
  coalesce((select sum(r.refund_egp) from public.returns r
             where r.order_id = o.id and r.refunded_at is null), 0)
                             as return_refund_owed_egp,
  coalesce((select sum(r.refund_egp) from public.returns r
             where r.order_id = o.id and r.refunded_at is not null), 0)
                             as return_refunded_egp
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
        'total_egp', l.total_egp,
        -- Pieces of it back from the customer, checked in. An exchange's old
        -- piece is the exchange's, shown there.
        'returned', (
          select coalesce(sum(rl.quantity_expected), 0)
            from public.return_lines rl
            join public.returns r on r.id = rl.return_id
           where rl.order_line_item_id = l.id
             and r.type <> 'exchange'
             and r.status in ('received', 'discrepancy', 'closed')
        )
      )
      order by l.created_at
    )                    as lines,
    sum(l.quantity)::int as unit_count
  from public.order_line_items l
  where l.order_id = o.id
) li on true
where o.archived_at is null;

-- --- Reports --------------------------------------------------------------------------------

-- As in 20261028100000, without a line the customer kept whole.
create or replace view public.v_report_returns
with (security_invoker = on) as
select
  rl.id as return_line_id,
  r.id as return_id,
  o.id as order_id,
  o.order_number,
  -- The day it came back; until it is checked in, the day it was reported.
  (coalesce(r.received_at, r.courier_reported_at, r.created_at) at time zone 'Africa/Cairo')::date
    as returned_on,
  r.type::text as return_type,
  r.reason::text as reason,
  o.channel::text as channel,
  c.governorate,
  o.customer_id,
  v.product_id,
  coalesce(p.title, li.title) as product_title,
  rl.variant_id,
  rl.sku,
  v.size,
  v.color,
  rl.quantity_expected as quantity,
  -- At what it sold for, after discounts: what the sale is worth less.
  round(
    case when li.quantity > 0
         then li.total_egp * case when o.subtotal_egp > 0 then o.total_egp / o.subtotal_egp else 1 end
              / li.quantity
         else 0 end
    * rl.quantity_expected,
    2) as value_egp
from public.return_lines rl
join public.returns r on r.id = rl.return_id
join public.orders o on o.id = r.order_id
left join public.order_line_items li on li.id = rl.order_line_item_id
left join public.customers c on c.id = o.customer_id
left join public.variants v on v.id = rl.variant_id
left join public.products p on p.id = v.product_id
where o.archived_at is null
  and rl.quantity_expected > 0;
