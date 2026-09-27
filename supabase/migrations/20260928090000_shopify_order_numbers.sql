-- ---------------------------------------------------------------------------
-- Website orders keep the number Shopify gave them.
--
-- The customer's confirmation email, the Shopify admin and whoever phones to
-- confirm all say "#1402". The CRM was giving the same order its own number,
-- W2609-00010, so matching the two meant looking one up in the other. Shopify's
-- name was already stored in source_detail; it is now the order number too.
--
-- Uniqueness holds: Shopify names are unique within the store, and the CRM's
-- own numbers (S2609-..., D2609-..., W2609-... for website orders taken by
-- hand on the sale screen) can never start with '#'. If a payload ever arrives
-- without a name, the CRM numbers it as before rather than refusing it.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_shopify_order(
  p_payload     jsonb,
  p_location_id uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shopify_id   bigint;
  v_order        public.orders;
  v_location_id  uuid;
  v_customer_id  uuid;
  v_item         jsonb;
  v_variant      public.variants;
  v_quantity     integer;
  v_unit_price   numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_line_total   numeric(12, 2);
  v_subtotal     numeric(12, 2) := 0;
  v_shipping     numeric(12, 2);
  v_discount     numeric(12, 2);
  v_gateways     text;
  v_payment      public.payment_method;
  v_payment_stat public.payment_status;
  v_movements    jsonb := '[]'::jsonb;
  v_unmatched    jsonb := '[]'::jsonb;
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify orders are ingested by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  v_shopify_id := nullif(p_payload ->> 'id', '')::bigint;
  if v_shopify_id is null then
    raise exception 'Payload has no order id' using errcode = 'invalid_parameter_value';
  end if;

  -- The replay path. Shopify redelivers, and a second delivery must not
  -- create a second order or deduct the stock again.
  select * into v_order from public.orders where shopify_order_id = v_shopify_id;
  if found then
    return v_order;
  end if;

  -- An explicitly named location wins. Otherwise ship from the default one.
  v_location_id := p_location_id;

  if v_location_id is null then
    select id into v_location_id
      from public.locations
     where is_default and is_active
     limit 1;
  end if;

  if v_location_id is null then
    raise exception 'No default location is configured to ship from'
      using errcode = 'no_data_found';
  end if;

  v_customer_id := public.upsert_shopify_customer(p_payload);

  -- Shipping sits in a money set rather than a plain field.
  v_shipping := coalesce(
    nullif(p_payload #>> '{total_shipping_price_set,shop_money,amount}', '')::numeric,
    0
  );
  v_discount := coalesce(nullif(p_payload ->> 'total_discounts', '')::numeric, 0);

  -- Gateway names are an array and a store can have several. Matching on the
  -- text of all of them is more robust than guessing one exact label, since
  -- the COD gateway is named differently on every store.
  select coalesce(string_agg(lower(value #>> '{}'), ','), '')
    into v_gateways
    from jsonb_array_elements(coalesce(p_payload -> 'payment_gateway_names', '[]'::jsonb));

  v_payment := case
    when v_gateways ~ 'cash|cod|delivery' then 'cod'
    when v_gateways ~ 'instapay'          then 'instapay'
    when v_gateways ~ 'bank|transfer'     then 'bank_transfer'
    when v_gateways = ''                  then 'cod'
    else 'card'
  end::public.payment_method;

  v_payment_stat := case lower(coalesce(p_payload ->> 'financial_status', 'pending'))
    when 'paid'               then 'paid'
    when 'partially_refunded' then 'partially_refunded'
    when 'refunded'           then 'refunded'
    when 'voided'             then 'failed'
    else 'pending'
  end::public.payment_status;

  -- Every order here is phoned to confirm before it ships, so that is where a
  -- new one starts rather than going straight into the packing queue.
  insert into public.orders (
    order_number, channel, fulfillment_status, payment_status, location_id,
    customer_id, payment_method, currency, shipping_egp, discount_egp,
    shopify_order_id, source_detail, note
  )
  values (
    coalesce(nullif(p_payload ->> 'name', ''), public.next_order_number('online')),
    'online', 'awaiting_confirmation', v_payment_stat,
    v_location_id, v_customer_id, v_payment,
    coalesce(nullif(p_payload ->> 'currency', ''), 'EGP'),
    v_shipping, v_discount, v_shopify_id,
    nullif(p_payload ->> 'name', ''),
    nullif(p_payload ->> 'note', '')
  )
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb))
  loop
    v_variant := null;

    if nullif(v_item ->> 'variant_id', '') is not null then
      select * into v_variant from public.variants
       where shopify_variant_id = (v_item ->> 'variant_id')::bigint;
    end if;

    if v_variant.id is null and nullif(v_item ->> 'sku', '') is not null then
      select * into v_variant from public.variants where sku = v_item ->> 'sku';
    end if;

    v_quantity      := coalesce(nullif(v_item ->> 'quantity', '')::integer, 0);
    v_unit_price    := coalesce(nullif(v_item ->> 'price', '')::numeric, 0);
    v_line_discount := coalesce(nullif(v_item ->> 'total_discount', '')::numeric, 0);
    v_line_total    := round(v_unit_price * v_quantity, 2) - v_line_discount;

    if v_quantity <= 0 then
      continue;
    end if;

    insert into public.order_line_items (
      order_id, variant_id, sku, title, quantity,
      unit_price_egp, discount_egp, total_egp
    )
    values (
      v_order.id, v_variant.id,
      coalesce(nullif(v_item ->> 'sku', ''), 'UNKNOWN'),
      coalesce(nullif(v_item ->> 'title', ''), 'Unknown item'),
      v_quantity, v_unit_price, v_line_discount, greatest(v_line_total, 0)
    );

    v_subtotal := v_subtotal + greatest(v_line_total, 0);

    if v_variant.id is null then
      -- Recorded rather than rejected. The customer has bought something, and
      -- an order we refuse to import is an order nobody packs.
      v_unmatched := v_unmatched || jsonb_build_object(
        'sku', v_item ->> 'sku',
        'title', v_item ->> 'title',
        'shopify_variant_id', v_item ->> 'variant_id'
      );
    elsif v_variant.track_inventory then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant.id,
        'quantity_delta', -v_quantity
      );
    end if;
  end loop;

  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         total_egp    = greatest(round(v_subtotal - v_discount, 2), 0)
   where id = v_order.id
  returning * into v_order;

  -- Shopify has already taken this off its own count at checkout, so our
  -- number and theirs land on the same figure and the outbound push that
  -- follows is a harmless no-op.
  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_location_id,
      p_reason          => 'online_order',
      p_movements       => v_movements,
      p_reference_type  => 'shopify_order',
      p_reference_id    => v_shopify_id::text,
      p_note            => null,
      p_idempotency_key => 'shopify_order:' || v_shopify_id::text
    );
  end if;

  if jsonb_array_length(v_unmatched) > 0 then
    perform public.open_sync_issue(
      'missing_in_crm', null, v_location_id, null, null,
      jsonb_build_object(
        'reason', 'order_contains_unknown_variants',
        'order_number', v_order.order_number,
        'shopify_order_id', v_shopify_id,
        'items', v_unmatched
      ),
      'webhook'
    );
  end if;

  return v_order;
end;
$$;

comment on function public.ingest_shopify_order is
  'Creates an online order, its customer, its lines and its stock movements as '
  'one transaction. Returns the existing order unchanged on a replay.';

-- --- Orders already in the CRM ----------------------------------------------

update public.orders
   set order_number = source_detail
 where shopify_order_id is not null
   and source_detail is not null
   and order_number <> source_detail;

-- --- Finding "#1402" when someone types "1402" -------------------------------
--
-- Nobody types the '#' at a counter. The lookup accepts the number with or
-- without it; nothing else in the function changes.

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

