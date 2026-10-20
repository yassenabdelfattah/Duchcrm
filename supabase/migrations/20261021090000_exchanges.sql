-- Exchanges: a piece swapped for another, by courier or in the shop.
--
-- The owner's rules (2026-10-21):
--   * Both ways: the courier swaps at the customer's door, or the customer
--     walks into the shop.
--   * The courier fee depends on why: the customer pays when they want a
--     different size or did not like it; it is free when it was our fault -
--     a faulty piece, or the wrong item sent. Editable either way.
--   * A different price is settled both ways: a dearer piece, the extra is
--     collected with the exchange; a cheaper one, the difference is owed back
--     to the customer.
--
-- The model, from docs/phase-3-orders-and-returns.md section 7: an exchange
-- is a return of the old piece plus a replacement order for the new one.
--
--   * The original order is left alone. It was delivered and its money is
--     what it was - the first version of create_exchange would have closed it
--     as "returned" when the old piece was checked in, which on a cash on
--     delivery order drops it off the owed list, the same way #1403 went
--     missing.
--   * The replacement is an ordinary order, packed, shipped and settled like
--     any other. The old piece's value is credited on it as its discount, so
--     it carries only the difference, and revenue counts only the difference.
--     A cheaper replacement leaves credit over: exchange_refund_egp, owed to
--     the customer until someone records paying it.
--   * The new piece leaves stock when the exchange is made, like any order.
--     The old one comes back only when it is physically checked in (DECISIONS
--     #3) - straight away in the shop, from the courier's parcel otherwise.
--   * Shopify is not touched: the website order is what the customer bought.
--     Stock pushes keep its counts right.

-- --- The replacement knows what it replaced -----------------------------------

alter table public.orders
  add column if not exists exchange_for_order_id uuid references public.orders (id) on delete restrict,
  add column if not exists exchange_refund_egp   numeric(12, 2) not null default 0
    check (exchange_refund_egp >= 0),
  add column if not exists exchange_refunded_at  timestamptz,
  add column if not exists exchange_refunded_by  uuid references public.staff (id) on delete set null;

comment on column public.orders.exchange_for_order_id is
  'On a replacement order: the order whose piece it replaced. Its discount is the credit for the piece coming back.';
comment on column public.orders.exchange_refund_egp is
  'Credit left over when the replacement was cheaper than the piece returned: owed back to the customer.';

create index if not exists orders_exchange_for_idx
  on public.orders (exchange_for_order_id) where exchange_for_order_id is not null;

-- --- Making one -----------------------------------------------------------------

drop function if exists public.create_exchange(uuid, jsonb, jsonb, public.return_reason, text);

create or replace function public.create_exchange(
  p_order_id          uuid,
  -- [{order_line_item_id, quantity, quantity_damaged?}] - what comes back.
  -- quantity_damaged only matters in the shop, where it is checked in now.
  p_return_lines      jsonb,
  -- [{variant_id, quantity}] - what goes out instead.
  p_replacement_items jsonb,
  p_reason            public.return_reason,
  p_in_store          boolean,
  p_shipping_egp      numeric               default 0,
  -- In the shop: how any difference is paid there and then.
  p_payment_method    public.payment_method default null,
  p_note              text                  default null,
  p_idempotency_key   text                  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders;
  v_replacement  public.orders;
  v_return       public.returns;
  v_item         jsonb;
  v_line         public.order_line_items;
  v_variant      public.variants;
  v_quantity     integer;
  v_damaged      integer;
  v_remaining    integer;
  v_factor       numeric;
  v_credit       numeric(12, 2) := 0;
  v_goods        numeric(12, 2) := 0;
  v_applied      numeric(12, 2);
  v_refund       numeric(12, 2);
  v_shipping     numeric(12, 2);
  v_channel      public.sales_channel;
  v_method       public.payment_method;
  v_receive      jsonb := '[]'::jsonb;
  v_rl           public.return_lines;
begin
  if not ((public.has_permission('orders.edit') and public.has_permission('returns.manage'))
          or public.is_service_request()) then
    raise exception 'You may not create an exchange' using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A double tap: the exchange already made, not a second one.
  select * into v_replacement from public.orders where idempotency_key = p_idempotency_key;
  if found then
    select * into v_return from public.returns where replacement_order_id = v_replacement.id;
    return jsonb_build_object(
      'return_id', v_return.id,
      'replacement_order_id', v_replacement.id,
      'replacement_order_number', v_replacement.order_number,
      'amount_due_egp', v_replacement.total_egp + v_replacement.shipping_egp,
      'refund_due_egp', v_replacement.exchange_refund_egp
    );
  end if;

  if p_reason not in ('wrong_size', 'not_as_expected', 'faulty', 'wrong_item_sent') then
    raise exception 'An exchange is for a size, a change of mind, a fault or a wrong item'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null or v_order.fulfillment_status <> 'delivered' then
    raise exception 'Order % has not been delivered, so there is nothing to exchange yet',
      v_order.order_number
      using errcode = 'check_violation', hint = 'exchange_needs_delivered';
  end if;

  if jsonb_typeof(p_return_lines) <> 'array' or jsonb_array_length(p_return_lines) = 0 then
    raise exception 'Choose the piece coming back' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_replacement_items) <> 'array' or jsonb_array_length(p_replacement_items) = 0 then
    raise exception 'Choose the piece going out instead' using errcode = 'invalid_parameter_value';
  end if;

  -- What the customer actually paid per unit: the line after its own
  -- discount, then the order's discount spread across the goods.
  v_factor := case when v_order.subtotal_egp > 0 then v_order.total_egp / v_order.subtotal_egp else 1 end;

  insert into public.returns (order_id, type, reason, status, note)
  values (p_order_id, 'exchange', p_reason, 'expected', p_note)
  returning * into v_return;

  for v_item in select * from jsonb_array_elements(p_return_lines)
  loop
    select * into v_line
      from public.order_line_items
     where id = (v_item ->> 'order_line_item_id')::uuid
       and order_id = p_order_id;
    if not found then
      raise exception 'Line % does not belong to order %', v_item ->> 'order_line_item_id', v_order.order_number
        using errcode = 'foreign_key_violation';
    end if;

    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    continue when v_quantity = 0;

    -- Pieces already on their way back, or back, cannot come back again.
    select v_line.quantity - coalesce(sum(
             case when r.status in ('expected', 'in_transit') then rl.quantity_expected
                  else rl.quantity_received end), 0)
      into v_remaining
      from public.return_lines rl
      join public.returns r on r.id = rl.return_id
     where rl.order_line_item_id = v_line.id
       and r.id <> v_return.id
       and r.type in ('post_delivery', 'exchange');

    if v_quantity < 0 or v_quantity > v_remaining then
      raise exception 'Only % of % can still come back', v_remaining, v_line.sku
        using errcode = 'check_violation';
    end if;

    v_damaged := least(greatest(coalesce((v_item ->> 'quantity_damaged')::integer, 0), 0), v_quantity);

    insert into public.return_lines (return_id, order_line_item_id, variant_id, sku, quantity_expected)
    values (v_return.id, v_line.id, v_line.variant_id, v_line.sku, v_quantity)
    returning * into v_rl;

    v_receive := v_receive || jsonb_build_object(
      'return_line_id', v_rl.id,
      'quantity_resellable', v_quantity - v_damaged,
      'quantity_damaged', v_damaged
    );

    v_credit := v_credit + round(v_line.total_egp / v_line.quantity * v_factor * v_quantity, 2);
  end loop;

  if jsonb_array_length(v_receive) = 0 then
    raise exception 'Choose the piece coming back' using errcode = 'invalid_parameter_value';
  end if;

  -- What the new pieces cost, the same price the sale will charge.
  for v_item in select * from jsonb_array_elements(p_replacement_items)
  loop
    select * into v_variant from public.variants where id = (v_item ->> 'variant_id')::uuid;
    if not found then
      raise exception 'Unknown variant %', v_item ->> 'variant_id' using errcode = 'foreign_key_violation';
    end if;
    v_goods := v_goods + round(v_variant.price_egp * coalesce((v_item ->> 'quantity')::integer, 0), 2);
  end loop;

  v_applied := least(v_credit, v_goods);
  v_refund  := v_credit - v_applied;
  v_shipping := case when p_in_store then 0 else round(greatest(coalesce(p_shipping_egp, 0), 0), 2) end;

  -- In the shop it is a counter sale. By courier it ships like the original,
  -- except a shop sale's replacement, which cannot be "store" and travel.
  v_channel := case
    when p_in_store then 'store'
    when v_order.channel = 'store' then 'dm'
    else v_order.channel
  end::public.sales_channel;

  v_method := case
    when p_in_store then coalesce(p_payment_method, 'cash')
    else 'cod'
  end::public.payment_method;

  v_replacement := public.create_store_sale(
    p_location_id     => v_order.location_id,
    p_payment_method  => v_method,
    p_items           => p_replacement_items,
    p_idempotency_key => p_idempotency_key,
    p_customer_id     => v_order.customer_id,
    p_discount_egp    => v_applied,
    -- The link is exchange_for_order_id, shown on the order in Arabic; a
    -- note in English would only repeat it.
    p_note            => p_note,
    p_channel         => v_channel,
    p_shipping_egp    => v_shipping
  );

  update public.orders
     set exchange_for_order_id = v_order.id,
         exchange_refund_egp   = v_refund,
         -- In the shop the difference is handed back over the counter.
         exchange_refunded_at  = case when p_in_store and v_refund > 0 then now() end,
         exchange_refunded_by  = case when p_in_store and v_refund > 0 then auth.uid() end,
         -- The call already happened: this was arranged with the customer.
         fulfillment_status    = case when p_in_store then 'delivered'
                                      else 'ready_to_pack' end::public.fulfillment_status,
         confirmed_at          = case when p_in_store then confirmed_at else now() end,
         confirmed_by          = case when p_in_store then confirmed_by else auth.uid() end,
         confirmation_outcome  = case when p_in_store then confirmation_outcome
                                      else 'confirmed' end::public.confirmation_outcome,
         -- Nothing to collect is nothing owed.
         payment_status        = case when total_egp + shipping_egp = 0 then 'paid'
                                      else payment_status end::public.payment_status
   where id = v_replacement.id
  returning * into v_replacement;

  update public.returns
     set replacement_order_id = v_replacement.id
   where id = v_return.id
  returning * into v_return;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (
    v_order.id, 'exchange', p_note,
    jsonb_build_object(
      'replacement_order_id', v_replacement.id,
      'replacement_order_number', v_replacement.order_number,
      'in_store', p_in_store,
      'credit_egp', v_credit
    ),
    auth.uid()
  );

  -- In the shop the old piece is on the counter: counted in now, which is
  -- what puts it back on the shelf.
  if p_in_store then
    v_return := public.receive_return(v_return.id, v_receive, null);
  end if;

  return jsonb_build_object(
    'return_id', v_return.id,
    'replacement_order_id', v_replacement.id,
    'replacement_order_number', v_replacement.order_number,
    'credit_egp', v_credit,
    'amount_due_egp', v_replacement.total_egp + v_replacement.shipping_egp,
    'refund_due_egp', v_refund
  );
end;
$$;

revoke execute on function public.create_exchange(uuid, jsonb, jsonb, public.return_reason, boolean, numeric, public.payment_method, text, text) from public, anon;
grant execute on function public.create_exchange(uuid, jsonb, jsonb, public.return_reason, boolean, numeric, public.payment_method, text, text) to authenticated, service_role;

-- --- The difference owed back -----------------------------------------------------

create or replace function public.mark_exchange_refunded(p_order_id uuid, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  if not (public.has_permission('orders.settle') or public.is_service_request()) then
    raise exception 'You may not record money paid' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.exchange_refund_egp <= 0 then
    raise exception 'Nothing is owed back on order %', v_order.order_number
      using errcode = 'check_violation';
  end if;

  if v_order.exchange_refunded_at is not null then
    return v_order;
  end if;

  update public.orders
     set exchange_refunded_at = now(),
         exchange_refunded_by = auth.uid()
   where id = p_order_id
  returning * into v_order;

  insert into public.order_events (order_id, event_type, note, details, staff_id)
  values (p_order_id, 'exchange_refunded', p_note,
          jsonb_build_object('amount_egp', v_order.exchange_refund_egp), auth.uid());

  return v_order;
end;
$$;

revoke execute on function public.mark_exchange_refunded(uuid, text) from public, anon;
grant execute on function public.mark_exchange_refunded(uuid, text) to authenticated, service_role;

-- --- The courier collects the old piece on the same visit --------------------------

create or replace function public.shipments_mark_exchange()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.direction = 'outbound'
     and exists (select 1 from public.orders o where o.id = new.order_id and o.exchange_for_order_id is not null)
  then
    new.collects_return := true;
  end if;
  return new;
end;
$$;

drop trigger if exists shipments_mark_exchange_trg on public.shipments;
create trigger shipments_mark_exchange_trg
  before insert on public.shipments
  for each row execute function public.shipments_mark_exchange();


-- --- Checking an exchange's old piece in ---------------------------------------

-- As in 20261005090000, except an exchange does not mark the original order
-- returned.
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

  return v_return;
end;
$function$;

-- --- Finding it on the returns screen ------------------------------------------

-- As in 20261005090000, plus the exchange whose replacement is this parcel.
CREATE OR REPLACE FUNCTION public.lookup_return_by_tracking(p_tracking text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_return   public.returns;
  v_customer public.customers;
  v_lines    jsonb;
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
    'exchange', case when v_return.type = 'exchange' then jsonb_build_object(
      'original_order_number', (select x.order_number from public.orders x where x.id = v_return.order_id),
      'replacement_order_number', (select x.order_number from public.orders x where x.id = v_return.replacement_order_id)
    ) end,
    'lines', v_lines,
    -- What went out, for the case where no return exists yet and the screen
    -- has to show the packer what to expect in the parcel.
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
$function$;

-- As in 20261005090000, plus a replacement's number finds its exchange.
CREATE OR REPLACE FUNCTION public.lookup_return_by_order_number(p_order_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_customer public.customers;
  v_shipment public.shipments;
  v_return   public.returns;
  v_lines    jsonb;
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
    'exchange', case when v_return.type = 'exchange' then jsonb_build_object(
      'original_order_number', (select x.order_number from public.orders x where x.id = v_return.order_id),
      'replacement_order_number', (select x.order_number from public.orders x where x.id = v_return.replacement_order_id)
    ) end,
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
$function$;

-- --- Cancelling a replacement --------------------------------------------------

-- As in 20261015090100, plus: cancelling a replacement closes its exchange.
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

-- --- What the screens see ---------------------------------------------------------

-- As in 20261015090100, with exchange columns on the end.
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
) li on true;

-- As in 20260928100000, with the exchange on the end.
create or replace view public.v_packing_queue
with (security_invoker = on) as
select
  o.id                       as order_id,
  o.order_number,
  o.channel,
  o.fulfillment_status,
  o.payment_status,
  o.payment_method,
  o.total_egp,
  o.shipping_egp,
  o.note,
  o.created_at,
  o.hold_until,
  o.confirmation_outcome,
  o.confirmation_attempts,
  c.id                       as customer_id,
  c.full_name                as customer_name,
  c.phone                    as customer_phone,
  c.address_line1,
  c.city,
  c.governorate,
  c.requires_prepayment,
  extract(epoch from (now() - o.created_at)) / 3600      as age_hours,
  (
    select coalesce(sum(li.quantity), 0)
      from public.order_line_items li where li.order_id = o.id
  )                          as unit_count,
  (
    select string_agg(li.sku || ' x' || li.quantity, ', ' order by li.created_at)
      from public.order_line_items li where li.order_id = o.id
  )                          as items,
  s.id                       as shipment_id,
  s.tracking_number,
  s.cod_amount_egp,
  (
    select count(*)
      from public.returns r
      join public.orders o2 on o2.id = r.order_id
     where o2.customer_id = c.id
       and r.type = 'failed_delivery'
  )                          as customer_prior_refusals,
  s.courier,
  s.driver_name,
  s.handed_over_at,
  -- Appended: a replacement, and the old piece the courier collects with it.
  (select x.order_number from public.orders x where x.id = o.exchange_for_order_id)
                             as exchange_for_order_number,
  (select string_agg(rl.sku || ' x' || rl.quantity_expected, ', ' order by rl.created_at)
     from public.returns r
     join public.return_lines rl on rl.return_id = r.id
    where r.replacement_order_id = o.id
      and r.type = 'exchange'
      and r.status in ('expected', 'in_transit'))
                             as exchange_collect_items
from public.orders o
left join public.customers c on c.id = o.customer_id
left join lateral (
  select sh.* from public.shipments sh
   where sh.order_id = o.id and sh.direction = 'outbound'
   order by sh.created_at desc
   limit 1
) s on true
where (
        o.fulfillment_status in (
          'awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup'
        )
        or (o.fulfillment_status = 'out_for_delivery' and s.courier = 'own')
      )
  and (o.hold_until is null or o.hold_until <= current_date);

-- As in 20260919130000, with an exchange's tracking code from its replacement.
create or replace view public.v_returns_inbound
with (security_invoker = on) as
select
  r.id                  as return_id,
  r.type,
  r.reason,
  r.status,
  r.courier_reported_at,
  o.id                  as order_id,
  o.order_number,
  o.payment_method,
  c.full_name           as customer_name,
  c.phone               as customer_phone,
  c.governorate,
  s.tracking_number,
  extract(epoch from (now() - coalesce(r.courier_reported_at, r.created_at))) / 86400
                        as days_since_reported,
  (
    select coalesce(sum(rl.quantity_expected), 0)
      from public.return_lines rl where rl.return_id = r.id
  )                     as units_expected,
  (
    select string_agg(rl.sku || ' x' || rl.quantity_expected, ', ' order by rl.created_at)
      from public.return_lines rl where rl.return_id = r.id
  )                     as items
from public.returns r
join public.orders o on o.id = r.order_id
left join public.customers c on c.id = o.customer_id
-- An exchange's old piece comes back on its replacement's parcel.
left join lateral (
  select sh.tracking_number
    from public.shipments sh
   where sh.id = r.outbound_shipment_id
      or (r.type = 'exchange' and sh.order_id = r.replacement_order_id and sh.direction = 'outbound')
   order by sh.created_at desc
   limit 1
) s on true
where r.status in ('expected', 'in_transit');

-- An exchange is not a new sale: its revenue (the difference) counts, but it
-- adds no order and no units - the units went out on the original.
create or replace view public.v_sales_summary_daily
with (security_invoker = on) as
select
  (o.created_at at time zone 'Africa/Cairo')::date as sale_date,
  o.channel,
  o.payment_method,
  count(*) filter (where o.exchange_for_order_id is null)       as order_count,
  sum(o.total_egp)                                               as revenue_egp,
  coalesce(sum(li.units) filter (where o.exchange_for_order_id is null), 0)
                                                                 as units_sold
from public.orders o
join lateral (
  select coalesce(sum(quantity), 0) as units
    from public.order_line_items
   where order_id = o.id
) li on true
where o.fulfillment_status not in ('cancelled', 'awaiting_confirmation')
group by 1, 2, 3;
