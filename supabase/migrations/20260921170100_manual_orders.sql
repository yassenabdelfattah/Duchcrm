-- ---------------------------------------------------------------------------
-- Orders taken by hand: a channel, a shipping fee, and paying later.
--
-- The sale screen was built for the counter, where the goods and the money
-- change hands at the same moment. Most orders do not work like that: they
-- arrive by Instagram or WhatsApp, they are shipped, the customer pays the
-- courier, and none of it happens at once. Those were being typed in as
-- counter sales, which recorded them as delivered and paid on the spot.
--
-- Three changes, all in one function because they are one decision:
--
--   * the channel decides whether an order is already finished or is only
--     just beginning;
--   * the payment method decides whether the money has arrived;
--   * shipping is charged on top, and is not part of the goods total.
-- ---------------------------------------------------------------------------

-- The parameter list changes, so this is a drop rather than a replace.
-- CREATE OR REPLACE with a different signature adds an overload instead of
-- replacing, and every existing call then fails as ambiguous.
drop function if exists public.create_store_sale(
  uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel
);

create function public.create_store_sale(
  p_location_id     uuid,
  p_payment_method  public.payment_method,
  p_items           jsonb,
  p_idempotency_key text,
  p_customer_id     uuid DEFAULT NULL,
  p_discount_egp    numeric DEFAULT 0,
  p_note            text DEFAULT NULL,
  p_channel         public.sales_channel DEFAULT 'store',
  p_shipping_egp    numeric DEFAULT 0
)
returns public.orders
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  v_shipping      numeric(12, 2);
  v_role          public.staff_role := public.auth_role();
  v_may_override  boolean;
  v_movements     jsonb := '[]'::jsonb;
  v_fulfillment   public.fulfillment_status;
  v_payment       public.payment_status;
begin
  perform public.assert_can_move_stock(
    case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
         else 'store_sale'::public.stock_movement_reason end
  );

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item'
      using errcode = 'invalid_parameter_value';
  end if;

  v_shipping := round(coalesce(p_shipping_egp, 0), 2);
  if v_shipping < 0 then
    raise exception 'Shipping cannot be negative'
      using errcode = 'invalid_parameter_value';
  end if;

  v_may_override := public.is_admin()
                    or v_role = 'stock_manager'
                    or public.is_service_request();

  -- Where the goods are.
  --
  -- A counter sale is handed over as it is rung up, so it is born delivered.
  -- Anything else has to be confirmed by phone, packed and shipped, so it
  -- starts at the front of the packing queue like an order from the website.
  -- The cast is explicit: a CASE returning string literals into an enum
  -- column is a mistake this project has made three times.
  v_fulfillment := case
    when p_channel = 'store' then 'delivered'
    else 'awaiting_confirmation'
  end::public.fulfillment_status;

  -- Where the money is, which moves on its own timeline.
  --
  -- Cash on delivery is collected by the courier and only becomes paid when
  -- the settlement containing it is reviewed - see DECISIONS.md. Paying later
  -- is a tab: the goods leave, the money is owed, and someone marks it paid
  -- when the customer settles. Everything else is money already taken.
  v_payment := case
    when p_payment_method in ('cod', 'deferred') then 'pending'
    else 'paid'
  end::public.payment_status;

  insert into public.orders (
    order_number, channel, fulfillment_status, payment_status, location_id,
    customer_id, staff_id, payment_method, note, idempotency_key, shipping_egp
  )
  values (
    public.next_order_number(p_channel), p_channel, v_fulfillment, v_payment, p_location_id,
    p_customer_id, auth.uid(), p_payment_method, p_note, p_idempotency_key, v_shipping
  )
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_variant
      from public.variants
     where id = (v_item ->> 'variant_id')::uuid;

    if not found then
      raise exception 'Unknown variant %', v_item ->> 'variant_id'
        using errcode = 'foreign_key_violation';
    end if;

    if not v_variant.is_active then
      raise exception 'Variant % (%) is not active and cannot be sold',
        v_variant.sku, v_variant.id
        using errcode = 'check_violation';
    end if;

    select title into v_product_title from public.products where id = v_variant.product_id;

    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Quantity for % must be a positive whole number', v_variant.sku
        using errcode = 'invalid_parameter_value';
    end if;

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
      v_order.id, v_variant.id, v_variant.sku, coalesce(v_product_title, v_variant.sku),
      nullif(concat_ws(' / ', v_variant.size, v_variant.color), ''),
      v_quantity, v_unit_price, v_line_discount, v_line_total
    );

    v_subtotal := v_subtotal + v_line_total;

    if v_variant.track_inventory then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant.id,
        'quantity_delta', -v_quantity
      );
    end if;
  end loop;

  v_total := round(v_subtotal - round(coalesce(p_discount_egp, 0), 2), 2);
  if v_total < 0 then
    raise exception 'Order discount is larger than the order subtotal'
      using errcode = 'check_violation';
  end if;

  -- total_egp is the goods, after discount, WITHOUT shipping. The customer
  -- pays total_egp + shipping_egp; see calculateInvoiceTotals in shared.
  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         discount_egp = round(coalesce(p_discount_egp, 0), 2),
         total_egp    = v_total
   where id = v_order.id
  returning * into v_order;

  -- Stock leaves when the order is taken, on every channel. There is no
  -- reservation concept yet (DECISIONS.md #8), so an order that is later
  -- refused comes back through the returns flow rather than by never having
  -- left. Manual entry is also refused outright when stock is short, unlike
  -- an order arriving from the storefront - the difference is that a person
  -- is standing here and can look.
  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => p_location_id,
      p_reason          => case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
                                else 'store_sale'::public.stock_movement_reason end,
      p_movements       => v_movements,
      p_reference_type  => 'order',
      p_reference_id    => v_order.id::text,
      p_note            => null,
      p_idempotency_key => 'order:' || v_order.id::text
    );
  end if;

  return v_order;
end;
$function$;

revoke execute on function public.create_store_sale(
  uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel, numeric
) from public, anon;
grant execute on function public.create_store_sale(
  uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel, numeric
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Settling a tab.
--
-- Until now an order became paid in exactly one place: reviewing the courier
-- settlement that contained it. That rule exists so cash collected at a door
-- is only recognised once it has actually been counted, and it still holds -
-- this function refuses a cash-on-delivery order outright.
--
-- What it adds is the other case: an order whose money was never with the
-- courier. Someone took the goods on a tab, came back, and paid.
-- ---------------------------------------------------------------------------

create or replace function public.mark_order_paid(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.orders;
begin
  if not (public.is_admin()
          or public.has_any_role('sales', 'stock_manager')
          or public.is_service_request()) then
    raise exception 'Not allowed to settle an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'Unknown order %', p_order_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: tapping twice is not an error, and the second tap must not
  -- write a second payment event.
  if v_order.payment_status = 'paid' then
    return v_order;
  end if;

  if v_order.payment_method = 'cod' then
    raise exception 'A cash-on-delivery order becomes paid when its settlement is reviewed, not here'
      using errcode = 'restrict_violation';
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'A cancelled order cannot be marked paid'
      using errcode = 'check_violation';
  end if;

  -- The status trigger writes the order_events row.
  update public.orders
     set payment_status = 'paid'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.mark_order_paid(uuid) is
  'Settles an order paid outside the courier flow - a tab, or a transfer that arrived late. Refuses cash on delivery.';

revoke execute on function public.mark_order_paid(uuid) from public, anon;
grant execute on function public.mark_order_paid(uuid) to authenticated, service_role;
