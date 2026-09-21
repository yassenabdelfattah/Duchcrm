-- ---------------------------------------------------------------------------
-- Editing an order.
--
-- Anything can happen between taking an order and shipping it: the customer
-- adds a second hoodie, changes to a bigger size, pays by InstaPay after
-- saying cash on delivery, gives a different address. None of that was
-- possible. The only options were to leave the order wrong or to cancel and
-- retype it, which loses the order number the customer was given and the
-- history attached to it.
--
-- Two rules shape this.
--
-- An order that has been paid for, or that appears on a courier statement,
-- cannot have its money changed. Those figures have been counted - by a
-- person against a bank transfer, or by the settlement that marked it paid -
-- and quietly editing them afterwards makes the books disagree with
-- themselves. The note can still be corrected; nothing else can.
--
-- Changing what is in the box moves stock, and stock is an append-only
-- ledger. So the difference is appended as a correcting movement with the
-- order against it, never by rewriting what was recorded at the time. Remove
-- a hoodie from an order and a hoodie comes back into stock, visibly, with
-- a reason and a name.
-- ---------------------------------------------------------------------------

/**
 * Shared guard. Raises when an order's money must not be touched.
 */
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

revoke execute on function public.assert_order_money_editable(public.orders) from public, anon;
grant execute on function public.assert_order_money_editable(public.orders) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The fields that are not the basket.
--
-- A null argument means "leave this alone", so a caller changing only the
-- shipping fee does not have to restate everything else and risk clobbering
-- a value someone edited a second ago.
-- ---------------------------------------------------------------------------

create or replace function public.update_order_details(
  p_order_id       uuid,
  p_shipping_egp   numeric DEFAULT NULL,
  p_discount_egp   numeric DEFAULT NULL,
  p_note           text DEFAULT NULL,
  p_payment_method public.payment_method DEFAULT NULL,
  p_channel        public.sales_channel DEFAULT NULL
)
returns public.orders
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order    public.orders;
  v_shipping numeric(12, 2);
  v_discount numeric(12, 2);
  v_touches_money boolean;
begin
  if not (public.is_admin()
          or public.has_any_role('stock_manager', 'sales')
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

  return v_order;
end;
$$;

revoke execute on function public.update_order_details(
  uuid, numeric, numeric, text, public.payment_method, public.sales_channel
) from public, anon;
grant execute on function public.update_order_details(
  uuid, numeric, numeric, text, public.payment_method, public.sales_channel
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What is in the box.
--
-- The whole basket is passed, not a delta, because that is what the screen
-- has and because working out the difference is exactly the part worth doing
-- in one place with the row locks held.
-- ---------------------------------------------------------------------------

create or replace function public.update_order_items(
  p_order_id uuid,
  p_items    jsonb
)
returns public.orders
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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
          or public.has_any_role('stock_manager', 'sales')
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
                    or public.auth_role() = 'stock_manager'
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

  return v_order;
end;
$$;

revoke execute on function public.update_order_items(uuid, jsonb) from public, anon;
grant execute on function public.update_order_items(uuid, jsonb) to authenticated, service_role;
