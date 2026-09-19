-- ---------------------------------------------------------------------------
-- Phase 3: bringing Shopify orders into the CRM.
--
-- Written as database functions rather than as TypeScript in the webhook
-- handler, for one reason: an order, its line items, its customer and its
-- stock movements have to land together or not at all. A handler making four
-- separate calls could leave an order with no stock deducted if the third one
-- failed, and the storefront would keep selling something already promised.
--
-- Each function is safe to call twice. Shopify retries anything it thinks
-- failed, and replays are normal rather than exceptional.
-- ---------------------------------------------------------------------------

-- --- Customer --------------------------------------------------------------

create or replace function public.upsert_shopify_customer(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer    jsonb := coalesce(p_payload -> 'customer', '{}'::jsonb);
  v_address     jsonb := coalesce(p_payload -> 'shipping_address',
                                  p_payload -> 'billing_address', '{}'::jsonb);
  v_shopify_id  bigint;
  v_phone       text;
  v_email       text;
  v_name        text;
  v_id          uuid;
begin
  v_shopify_id := nullif(v_customer ->> 'id', '')::bigint;

  -- Shopify puts a phone number in up to three places and they do not always
  -- agree. The shipping address one is what the courier will actually call.
  v_phone := public.normalize_eg_phone(
    coalesce(
      nullif(v_address ->> 'phone', ''),
      nullif(p_payload ->> 'phone', ''),
      nullif(v_customer ->> 'phone', '')
    )
  );

  v_email := lower(nullif(coalesce(p_payload ->> 'email', v_customer ->> 'email'), ''));

  v_name := nullif(trim(concat_ws(' ',
    coalesce(nullif(v_address ->> 'first_name', ''), v_customer ->> 'first_name'),
    coalesce(nullif(v_address ->> 'last_name', ''),  v_customer ->> 'last_name')
  )), '');

  -- Match on the Shopify id first, then the phone number. Phone is the
  -- identifier that actually carries across the website, Instagram and the
  -- till, which is what makes one customer history possible.
  if v_shopify_id is not null then
    select id into v_id from public.customers where shopify_customer_id = v_shopify_id;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from public.customers where phone = v_phone;
  end if;

  if v_id is null then
    insert into public.customers (
      shopify_customer_id, full_name, phone, email,
      address_line1, address_line2, city, governorate
    )
    values (
      v_shopify_id, v_name, v_phone, v_email,
      nullif(v_address ->> 'address1', ''),
      nullif(v_address ->> 'address2', ''),
      nullif(v_address ->> 'city', ''),
      nullif(v_address ->> 'province', '')
    )
    returning id into v_id;
    return v_id;
  end if;

  -- Fill in blanks without overwriting anything a person typed by hand.
  update public.customers
     set shopify_customer_id = coalesce(shopify_customer_id, v_shopify_id),
         full_name           = coalesce(full_name, v_name),
         phone               = coalesce(phone, v_phone),
         email               = coalesce(email, v_email::citext),
         address_line1       = coalesce(address_line1, nullif(v_address ->> 'address1', '')),
         city                = coalesce(city, nullif(v_address ->> 'city', '')),
         governorate         = coalesce(governorate, nullif(v_address ->> 'province', ''))
   where id = v_id;

  return v_id;
end;
$$;

-- --- Order -----------------------------------------------------------------

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

  select coalesce(p_location_id, id) into v_location_id
    from public.locations
   where is_default and is_active
   limit 1;

  if v_location_id is null then
    v_location_id := p_location_id;
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
    public.next_order_number('online'), 'online', 'awaiting_confirmation', v_payment_stat,
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

-- --- Cancellation ----------------------------------------------------------

create or replace function public.cancel_shopify_order(
  p_shopify_order_id bigint,
  p_reason           text default null
)
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

  return public.cancel_order(v_order.id, coalesce(p_reason, 'Cancelled in Shopify'));
end;
$$;

-- --- Refunds ---------------------------------------------------------------

create or replace function public.apply_shopify_refund(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund_id  bigint;
  v_order_id   bigint;
  v_order      public.orders;
  v_item       jsonb;
  v_variant_id uuid;
  v_quantity   integer;
  v_movements  jsonb := '[]'::jsonb;
  v_restocked  integer := 0;
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify refunds are applied by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  v_refund_id := nullif(p_payload ->> 'id', '')::bigint;
  v_order_id  := nullif(p_payload ->> 'order_id', '')::bigint;

  select * into v_order from public.orders where shopify_order_id = v_order_id;
  if not found then
    raise exception 'No CRM order for Shopify order %', v_order_id
      using errcode = 'no_data_found';
  end if;

  for v_item in
    select * from jsonb_array_elements(coalesce(p_payload -> 'refund_line_items', '[]'::jsonb))
  loop
    v_quantity := coalesce(nullif(v_item ->> 'quantity', '')::integer, 0);
    if v_quantity <= 0 then
      continue;
    end if;

    select v.id into v_variant_id
      from public.variants v
     where v.shopify_variant_id = nullif(v_item #>> '{line_item,variant_id}', '')::bigint
        or v.sku = nullif(v_item #>> '{line_item,sku}', '');

    -- Shopify says whether the refund restocked. If it did not, the goods are
    -- still with the customer and must not reappear in our count.
    if v_variant_id is not null and coalesce((v_item ->> 'restock_type'), '') <> 'no_restock' then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant_id,
        'quantity_delta', v_quantity
      );
      v_restocked := v_restocked + v_quantity;
    end if;
  end loop;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'return',
      p_movements       => v_movements,
      p_reference_type  => 'shopify_refund',
      p_reference_id    => v_refund_id::text,
      p_note            => 'Refunded in Shopify',
      p_idempotency_key => 'shopify_refund:' || v_refund_id::text
    );
  end if;

  update public.orders
     set payment_status = case
           when round(total_egp, 2) <= round(
                  coalesce(nullif(p_payload ->> 'total_refunded_set', '')::numeric, 0), 2)
             then 'refunded'::public.payment_status
           else 'partially_refunded'::public.payment_status
         end
   where id = v_order.id;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'units_restocked', v_restocked
  );
end;
$$;

revoke execute on function public.ingest_shopify_order(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.ingest_shopify_order(jsonb, uuid) to service_role;

revoke execute on function public.cancel_shopify_order(bigint, text) from public, anon, authenticated;
grant execute on function public.cancel_shopify_order(bigint, text) to service_role;

revoke execute on function public.apply_shopify_refund(jsonb) from public, anon, authenticated;
grant execute on function public.apply_shopify_refund(jsonb) to service_role;

revoke execute on function public.upsert_shopify_customer(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_shopify_customer(jsonb) to service_role;
