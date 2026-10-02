-- ---------------------------------------------------------------------------
-- A returned order is closed.
--
-- Found on S2609-00015: a shop sale on cash on delivery, never paid, brought
-- back through Returns. The goods went back into stock and the order showed
-- "returned" - but its payment still read "unpaid", so the Orders screen
-- counted it as money owed and offered Mark paid, and someone pressed it.
-- Nothing is owed on goods we have back.
--
-- The payment status itself is deliberately left as it is. A courier parcel
-- that came back is still expected on Accurate's statement - with a return
-- fee against it - and v_awaiting_settlement finds it by being unpaid. So
-- "closed" is a rule on the order, not a new payment state:
--
--   * Mark paid refuses an order whose goods are back or on their way back.
--   * Its money and its items cannot be edited either. Editing the basket of
--     a returned order would append a stock movement for goods the return
--     already put back - counting them twice. The note stays editable, as on
--     a paid order.
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

  if v_order.cancelled_at is not null then
    raise exception 'A cancelled order cannot be marked paid'
      using errcode = 'check_violation';
  end if;

  if v_order.fulfillment_status in ('returned', 'return_in_transit') then
    raise exception 'Order % was returned, so nothing is owed on it', v_order.order_number
      using errcode = 'check_violation', hint = 'order_returned';
  end if;

  -- The status trigger writes the order_events row, with who did it.
  update public.orders
     set payment_status = 'paid'
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

comment on function public.mark_order_paid(uuid) is
  'Marks an unpaid order paid, whatever its payment method, with the name of '
  'whoever did it. Refuses a cancelled or returned order. The courier '
  'settlement review skips an order already paid.';

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
