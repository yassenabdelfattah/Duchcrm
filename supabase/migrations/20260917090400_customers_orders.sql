-- ---------------------------------------------------------------------------
-- Phase 2: customers, orders, and the in-store sale.
--
-- There is one orders table rather than a separate "sales" table, with a
-- channel column telling them apart. An in-store sale is simply an order with
-- channel = 'store' that is paid and handed over at the moment it is created.
-- Phase 2 only ever writes 'store' rows, but Shopify orders (Phase 3),
-- wholesale (Phase 4) and cross-channel customer history all land in the same
-- place with no migration and no union queries.
-- ---------------------------------------------------------------------------

create type public.sales_channel  as enum ('store', 'online', 'dm', 'wholesale');
create type public.payment_method as enum ('cash', 'card', 'instapay', 'cod', 'bank_transfer');
create type public.order_status   as enum ('draft', 'confirmed', 'completed', 'cancelled', 'refunded');

-- --- Customers -------------------------------------------------------------

create table public.customers (
  id                   uuid primary key default gen_random_uuid(),
  shopify_customer_id  bigint unique,
  full_name            text,
  phone                text,
  email                citext,
  instagram_handle     text,
  whatsapp_phone       text,
  is_wholesale         boolean not null default false,
  address_line1        text,
  address_line2        text,
  city                 text,
  governorate          text,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.customers is
  'Optional on a store sale - walk-in customers leave customer_id null.';

create trigger customers_touch_updated_at
  before update on public.customers
  for each row execute function public.touch_updated_at();

-- Egyptian mobile numbers arrive as +20 10..., 0020 10..., 010..., 10... .
-- Storing them in one shape is what makes "has this person bought from us
-- before?" work across the website, Instagram and the till.
create or replace function public.normalize_eg_phone(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  v_digits text;
begin
  if p_phone is null then return null; end if;

  v_digits := regexp_replace(p_phone, '\D', '', 'g');
  if v_digits = '' then return null; end if;

  if left(v_digits, 4) = '0020' then
    v_digits := substr(v_digits, 5);
  elsif left(v_digits, 2) = '20' and length(v_digits) > 10 then
    v_digits := substr(v_digits, 3);
  end if;

  if left(v_digits, 1) <> '0' then
    v_digits := '0' || v_digits;
  end if;

  if v_digits ~ '^01[0125]\d{8}$' then
    return v_digits;
  end if;

  -- Keep whatever was entered rather than losing a landline or a foreign
  -- number; only well-formed mobiles get the canonical form.
  return regexp_replace(p_phone, '\s', '', 'g');
end;
$$;

create or replace function public.customers_normalize()
returns trigger
language plpgsql
as $$
begin
  new.phone := public.normalize_eg_phone(new.phone);
  new.whatsapp_phone := public.normalize_eg_phone(new.whatsapp_phone);
  new.instagram_handle := nullif(lower(regexp_replace(coalesce(new.instagram_handle, ''), '^@', '')), '');
  return new;
end;
$$;

create trigger customers_normalize_trg
  before insert or update on public.customers
  for each row execute function public.customers_normalize();

create unique index customers_phone_idx on public.customers (phone) where phone is not null;
create unique index customers_instagram_idx on public.customers (instagram_handle)
  where instagram_handle is not null;
create index customers_name_trgm_idx on public.customers using gin (full_name gin_trgm_ops);

-- --- Orders ----------------------------------------------------------------

create sequence public.order_number_seq;

create or replace function public.next_order_number(p_channel public.sales_channel)
returns text
language sql
volatile
as $$
  select case p_channel
           when 'store'     then 'S'
           when 'online'    then 'W'
           when 'dm'        then 'D'
           when 'wholesale' then 'B'
         end
         || to_char(now() at time zone 'Africa/Cairo', 'YYMM')
         || '-'
         || lpad(nextval('public.order_number_seq')::text, 5, '0');
$$;

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text not null unique,
  channel          public.sales_channel not null,
  status           public.order_status not null default 'completed',
  location_id      uuid references public.locations (id) on delete restrict,
  customer_id      uuid references public.customers (id) on delete set null,
  staff_id         uuid references public.staff (id) on delete set null,
  payment_method   public.payment_method,
  currency         text not null default 'EGP',
  subtotal_egp     numeric(12, 2) not null default 0 check (subtotal_egp >= 0),
  discount_egp     numeric(12, 2) not null default 0 check (discount_egp >= 0),
  shipping_egp     numeric(12, 2) not null default 0 check (shipping_egp >= 0),
  total_egp        numeric(12, 2) not null default 0 check (total_egp >= 0),
  shopify_order_id bigint unique,
  source_detail    text,
  note             text,
  idempotency_key  text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  cancelled_at     timestamptz,
  cancelled_by     uuid references public.staff (id) on delete set null,
  cancel_reason    text
);

comment on column public.orders.source_detail is
  'Free text for where a DM order came from, e.g. an Instagram handle.';
comment on column public.orders.idempotency_key is
  'Generated by the sale screen when it opens. A double-tapped confirm button '
  'returns the first sale instead of selling the stock twice.';

create index orders_channel_created_idx on public.orders (channel, created_at desc);
create index orders_customer_idx on public.orders (customer_id) where customer_id is not null;
create index orders_status_idx on public.orders (status);
create index orders_staff_idx on public.orders (staff_id, created_at desc);

create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- --- Line items ------------------------------------------------------------

create table public.order_line_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  variant_id      uuid references public.variants (id) on delete restrict,
  sku             text not null,
  title           text not null,
  variant_title   text,
  quantity        integer not null check (quantity > 0),
  unit_price_egp  numeric(12, 2) not null check (unit_price_egp >= 0),
  discount_egp    numeric(12, 2) not null default 0 check (discount_egp >= 0),
  total_egp       numeric(12, 2) not null check (total_egp >= 0),
  created_at      timestamptz not null default now()
);

comment on column public.order_line_items.sku is
  'Copied at sale time, not joined. Product titles and prices change; a '
  'reprinted receipt from six months ago must still show what was actually sold.';

create index order_line_items_order_idx on public.order_line_items (order_id);
create index order_line_items_variant_idx on public.order_line_items (variant_id);

-- --- Making a sale ---------------------------------------------------------

create or replace function public.create_store_sale(
  p_location_id     uuid,
  p_payment_method  public.payment_method,
  p_items           jsonb,
  p_idempotency_key text,
  p_customer_id     uuid default null,
  p_discount_egp    numeric default 0,
  p_note            text default null,
  p_channel         public.sales_channel default 'store'
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders;
  v_item         jsonb;
  v_variant      public.variants;
  v_product_title text;
  v_quantity     integer;
  v_unit_price   numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_line_total   numeric(12, 2);
  v_subtotal     numeric(12, 2) := 0;
  v_total        numeric(12, 2);
  v_role         public.staff_role := public.auth_role();
  v_may_override boolean;
  v_movements    jsonb := '[]'::jsonb;
begin
  perform public.assert_can_move_stock(
    case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
         else 'store_sale'::public.stock_movement_reason end
  );

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The retry path. Returning the original sale is what makes it safe for the
  -- cashier to tap confirm again when the phone's signal drops.
  select * into v_order from public.orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Only senior staff may sell at a price other than the one on the variant.
  -- Otherwise a mistyped or malicious client could sell a jacket for 1 EGP.
  v_may_override := public.is_admin()
                    or v_role = 'stock_manager'
                    or public.is_service_request();

  insert into public.orders (
    order_number, channel, status, location_id, customer_id, staff_id,
    payment_method, note, idempotency_key
  )
  values (
    public.next_order_number(p_channel), p_channel, 'completed', p_location_id,
    p_customer_id, auth.uid(), p_payment_method, p_note, p_idempotency_key
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

  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         discount_egp = round(coalesce(p_discount_egp, 0), 2),
         total_egp    = v_total
   where id = v_order.id
  returning * into v_order;

  -- Stock comes off last, inside the same transaction. If any line would take
  -- stock below zero the trigger raises, and the order, its line items and
  -- every other movement in this batch are all rolled back together. The
  -- cashier sees "not enough stock" and nothing was half-recorded.
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
$$;

comment on function public.create_store_sale is
  'Creates an order, its line items and the matching stock movements as one '
  'atomic unit. Prices are read from the database, never taken from the client.';

-- --- Undoing a sale --------------------------------------------------------

create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders;
  v_movements jsonb := '[]'::jsonb;
  v_line      record;
begin
  if not (public.is_admin() or public.has_any_role('stock_manager') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may cancel an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.status = 'cancelled' then
    return v_order;
  end if;

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

  -- The original movements are never edited or deleted. The stock comes back
  -- as new rows pointing at the same order, so the ledger reads as a story:
  -- sold on Tuesday, returned on Thursday.
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
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancelled_by  = auth.uid(),
         cancel_reason = p_reason
   where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

revoke execute on function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel) from public, anon;
grant execute on function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel) to authenticated, service_role;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;
