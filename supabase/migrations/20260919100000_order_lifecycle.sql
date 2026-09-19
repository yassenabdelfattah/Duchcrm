-- ---------------------------------------------------------------------------
-- Phase 3: the order lifecycle.
--
-- The single `status` column from Phase 2 is replaced by two, because with
-- cash on delivery the goods and the money move on completely separate
-- timelines. A parcel is delivered on Tuesday; the courier remits the cash the
-- following week. One column cannot say "the customer has it, we have not been
-- paid" without inventing a combined value for every pair, and the number of
-- pairs only grows.
--
-- Every transition is also written to order_events, so "how long do orders sit
-- before packing" and "who marked this delivered" stay answerable. Same
-- principle as the stock ledger: record what happened, do not overwrite it.
-- ---------------------------------------------------------------------------

create type public.fulfillment_status as enum (
  'awaiting_confirmation',  -- new, nobody has called the customer yet
  'confirmed',              -- customer confirmed they want it
  'ready_to_pack',          -- queued for the packer
  'packed',                 -- in a box, waiting for the pickup car
  'awaiting_pickup',        -- handed to the courier system, tracking number issued
  'in_transit',             -- collected, in courier custody
  'out_for_delivery',       -- on the van
  'delivered',              -- handed to the customer
  'delivery_failed',        -- refused, unreachable, or bad address
  'return_in_transit',      -- coming back to us, still in courier custody
  'returned',               -- physically back in the office and counted
  'cancelled'               -- killed before it shipped
);

comment on type public.fulfillment_status is
  'Where the goods are. Says nothing about whether we have been paid.';

create type public.payment_status as enum (
  'pending',              -- COD not yet collected, or collected but not remitted
  'paid',                 -- money is actually ours, matched to a settlement
  'partially_refunded',
  'refunded',
  'failed'
);

comment on type public.payment_status is
  'Where the money is. A COD order stays pending through delivery and only '
  'becomes paid when the courier settlement that contains it is reviewed.';

-- --- Replace the old column ------------------------------------------------

-- The view reads orders.status, so it has to go before the column can.
drop view if exists public.v_sales_summary_daily;

alter table public.orders add column fulfillment_status public.fulfillment_status;
alter table public.orders add column payment_status public.payment_status;

update public.orders
   set fulfillment_status = case status
         when 'draft'     then 'awaiting_confirmation'
         when 'confirmed' then 'confirmed'
         when 'completed' then 'delivered'
         when 'cancelled' then 'cancelled'
         when 'refunded'  then 'delivered'
       end::public.fulfillment_status,
       payment_status = case
         when status = 'refunded' then 'refunded'
         -- A store sale is paid at the counter, by definition.
         when channel = 'store' and status = 'completed' then 'paid'
         else 'pending'
       end::public.payment_status;

alter table public.orders alter column fulfillment_status set not null;
alter table public.orders alter column payment_status set not null;
alter table public.orders alter column fulfillment_status set default 'awaiting_confirmation';
alter table public.orders alter column payment_status set default 'pending';

alter table public.orders drop column status;
drop type public.order_status;

create index orders_fulfillment_idx on public.orders (fulfillment_status, created_at desc);
create index orders_payment_idx on public.orders (payment_status)
  where payment_status = 'pending';

-- --- Confirmation call -----------------------------------------------------
--
-- Every order is called before it ships, COD or not. Recording the outcome is
-- what turns that from a habit into something measurable: an order that was
-- confirmed and still refused at the door is telling you something quite
-- different from one that was never reached.

create type public.confirmation_outcome as enum (
  'confirmed',
  'unreachable',
  'cancelled_by_customer',
  'asked_to_delay'
);

alter table public.orders
  add column confirmation_outcome  public.confirmation_outcome,
  add column confirmation_attempts integer not null default 0,
  add column confirmed_at          timestamptz,
  add column confirmed_by          uuid references public.staff (id) on delete set null,
  -- When the customer asked us to hold it. Keeps the queue honest rather than
  -- leaving the order looking neglected.
  add column hold_until            date;

comment on column public.orders.confirmation_attempts is
  'How many times we tried to reach them. A high number with no confirmation '
  'is the signal to stop spending a courier run on this order.';

-- --- The event log ---------------------------------------------------------

create table public.order_events (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete cascade,
  event_type          text not null,
  from_fulfillment    public.fulfillment_status,
  to_fulfillment      public.fulfillment_status,
  from_payment        public.payment_status,
  to_payment          public.payment_status,
  note                text,
  details             jsonb not null default '{}'::jsonb,
  staff_id            uuid references public.staff (id) on delete set null,
  created_at          timestamptz not null default now()
);

comment on table public.order_events is
  'Append-only history of everything that happened to an order.';

create index order_events_order_idx on public.order_events (order_id, created_at);
create index order_events_type_idx on public.order_events (event_type, created_at desc);

create or replace function public.order_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'order_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger order_events_no_update
  before update on public.order_events
  for each row execute function public.order_events_block_mutation();

create trigger order_events_no_delete
  before delete on public.order_events
  for each row execute function public.order_events_block_mutation();

-- Logged by a trigger rather than by each caller, so a transition can never be
-- made without leaving a trace - including one made by hand in psql.
create or replace function public.orders_log_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (
      order_id, event_type, to_fulfillment, to_payment, staff_id
    )
    values (new.id, 'created', new.fulfillment_status, new.payment_status, new.staff_id);
    return new;
  end if;

  if new.fulfillment_status is distinct from old.fulfillment_status then
    insert into public.order_events (
      order_id, event_type, from_fulfillment, to_fulfillment, note, staff_id
    )
    values (
      new.id, 'fulfillment_change', old.fulfillment_status, new.fulfillment_status,
      new.cancel_reason, auth.uid()
    );
  end if;

  if new.payment_status is distinct from old.payment_status then
    insert into public.order_events (
      order_id, event_type, from_payment, to_payment, staff_id
    )
    values (new.id, 'payment_change', old.payment_status, new.payment_status, auth.uid());
  end if;

  return new;
end;
$$;

create trigger orders_log_transition_insert
  after insert on public.orders
  for each row execute function public.orders_log_transition();

create trigger orders_log_transition_update
  after update on public.orders
  for each row execute function public.orders_log_transition();

-- --- Rebuild what depended on the old column -------------------------------

create or replace view public.v_sales_summary_daily
with (security_invoker = on) as
select
  (o.created_at at time zone 'Africa/Cairo')::date as sale_date,
  o.channel,
  o.payment_method,
  count(*)                                        as order_count,
  sum(o.total_egp)                                as revenue_egp,
  sum(li.units)                                   as units_sold
from public.orders o
join lateral (
  select coalesce(sum(quantity), 0) as units
    from public.order_line_items
   where order_id = o.id
) li on true
where o.fulfillment_status not in ('cancelled', 'awaiting_confirmation')
group by 1, 2, 3;

grant select on public.v_sales_summary_daily to authenticated;

-- create_store_sale and cancel_order both wrote to the old column.

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
  v_role          public.staff_role := public.auth_role();
  v_may_override  boolean;
  v_movements     jsonb := '[]'::jsonb;
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

  v_may_override := public.is_admin()
                    or v_role = 'stock_manager'
                    or public.is_service_request();

  -- A store sale is handed over and paid at the counter, so it starts life
  -- already delivered and already paid. Nothing else in the lifecycle applies.
  insert into public.orders (
    order_number, channel, fulfillment_status, payment_status, location_id,
    customer_id, staff_id, payment_method, note, idempotency_key
  )
  values (
    public.next_order_number(p_channel), p_channel, 'delivered', 'paid', p_location_id,
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

  return v_order;
end;
$$;

revoke execute on function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel) from public, anon;
grant execute on function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel) to authenticated, service_role;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated, service_role;

alter table public.order_events enable row level security;

create policy order_events_select on public.order_events
  for select to authenticated
  using ((select public.is_staff()));

grant select on public.order_events to authenticated;
grant all on public.order_events to service_role;
