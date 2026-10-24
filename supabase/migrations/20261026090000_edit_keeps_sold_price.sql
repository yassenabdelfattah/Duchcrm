-- An order keeps the prices it was sold at (2026-10-26).
--
-- Every line already stores the price it was sold at, so changing a product's
-- price never touched an order. But editing one did: update_order_items
-- priced every line at the variant's price today and dropped any discount on
-- a line. And the order editor saves the items with every Save, so fixing a
-- customer's phone number on an unpaid order after a price change quietly
-- re-priced it - while the screen still showed the old prices.
--
-- Now a variant already on the order keeps its price and its discount per
-- piece, whatever its quantity becomes (the owner's choice: one hoodie
-- becoming two is two at the price it was ordered at). Only a variant new to
-- the order takes today's price.

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
  v_sold          jsonb;
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

  -- And what each of them was sold at. A price changed since the order was
  -- taken is not the customer's to pay: a variant already on the order keeps
  -- its price, and its discount per piece, however its quantity changes. Only
  -- a variant new to the order is priced at today's price.
  select coalesce(jsonb_object_agg(t.variant_id::text, jsonb_build_object(
           'unit_price_egp', t.unit_price_egp,
           'discount_per_unit', t.discount_per_unit
         )), '{}'::jsonb)
    into v_sold
    from (
      select distinct on (li.variant_id)
             li.variant_id,
             li.unit_price_egp,
             sum(li.discount_egp) over (partition by li.variant_id)
               / nullif(sum(li.quantity) over (partition by li.variant_id), 0) as discount_per_unit
        from public.order_line_items li
       where li.order_id = p_order_id and li.variant_id is not null
       order by li.variant_id, li.created_at
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
      when v_sold ? v_variant.id::text
        then (v_sold -> v_variant.id::text ->> 'unit_price_egp')::numeric
      else v_variant.price_egp
    end;

    v_line_discount := round(case
      when v_item ? 'discount_egp'
        then coalesce((v_item ->> 'discount_egp')::numeric, 0)
      when v_sold ? v_variant.id::text
        then coalesce((v_sold -> v_variant.id::text ->> 'discount_per_unit')::numeric, 0) * v_quantity
      else 0
    end, 2);
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

