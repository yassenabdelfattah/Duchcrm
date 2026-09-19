-- ---------------------------------------------------------------------------
-- Phase 3: shipments, custody, and returns.
--
-- The custody requirement drives most of this. Nothing leaves the office
-- untracked, and a parcel stays accounted for from the moment the courier
-- takes it until it is either delivered or physically back on the table. A
-- three-item order that comes back with two items has to be recordable,
-- visible, and chaseable - that is the whole point.
--
-- Stock does not move while goods are in a van. A refusal normally lands back
-- within two or three days, so anything still in courier custody after a week
-- is an exception worth a phone call. The aged exception list, not the
-- tracking itself, is the actual control.
-- ---------------------------------------------------------------------------

create type public.shipment_direction as enum ('outbound', 'return');

create type public.shipment_status as enum (
  'created',
  'awaiting_pickup',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'return_in_transit',
  'returned',
  'cancelled'
);

create table public.shipments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders (id) on delete restrict,
  courier           text not null default 'accurate',
  -- The courier's own code, on the label they stick to the parcel. Until the
  -- Accurate integration exists the packer types or scans it in; the barcode
  -- scanner built in Phase 2 reads it off their label directly.
  tracking_number   text,
  direction         public.shipment_direction not null default 'outbound',
  status            public.shipment_status not null default 'created',
  -- True when the courier is also collecting something on the same visit,
  -- which is how an exchange physically happens here.
  collects_return   boolean not null default false,
  zone              text,
  subzone           text,
  service_type      text,
  -- What the courier should collect at the door: goods plus shipping, since
  -- the customer pays shipping on top and it is inside the COD amount.
  cod_amount_egp    numeric(12, 2) not null default 0 check (cod_amount_egp >= 0),
  handed_over_at    timestamptz,
  delivered_at      timestamptz,
  failed_at         timestamptz,
  returned_at       timestamptz,
  last_tracked_at   timestamptz,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.shipments is
  'One row per parcel movement. An order normally has one outbound shipment, '
  'plus a return shipment if it comes back.';

create unique index shipments_tracking_idx
  on public.shipments (courier, tracking_number)
  where tracking_number is not null;

create index shipments_order_idx on public.shipments (order_id);
create index shipments_status_idx on public.shipments (status, handed_over_at);

-- Everything currently in courier custody. The partial index keeps this fast
-- no matter how much history accumulates.
create index shipments_in_custody_idx
  on public.shipments (handed_over_at)
  where status in ('in_transit', 'out_for_delivery', 'delivery_failed', 'return_in_transit');

create trigger shipments_touch_updated_at
  before update on public.shipments
  for each row execute function public.touch_updated_at();

-- --- Returns ---------------------------------------------------------------

create type public.return_type as enum (
  'failed_delivery',   -- never accepted. Customer had nothing and paid nothing.
  'post_delivery',     -- they had it and sent it back
  'exchange'           -- swapped for something else
);

create type public.return_reason as enum (
  -- Failed delivery. These two are where most of Duch's returns come from.
  'no_response',              -- never answered, never scheduled. Small courier fee.
  'refused_after_inspection', -- opened at the door and declined. Full shipping fee.
  'refused_unopened',
  'wrong_address',
  'delivery_timeout',
  -- Post-delivery.
  'wrong_size',
  'not_as_expected',
  'faulty',
  -- Ours, not theirs. Kept separate because it is a packing error to fix,
  -- not a customer decision to analyse.
  'wrong_item_sent'
);

comment on type public.return_reason is
  'refused_after_inspection is separate from refused_unopened on purpose: the '
  'garment was handled and the packaging opened, it costs a full shipping fee, '
  'and it is the refusal that says the most about the product itself.';

create type public.return_status as enum (
  'expected',     -- the courier says it is coming back
  'in_transit',   -- confirmed on its way
  'received',     -- physically here and counted
  'closed',       -- resolved, including any shortfall
  'discrepancy'   -- arrived short. Stays open until settled.
);

create table public.returns (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders (id) on delete restrict,
  outbound_shipment_id uuid references public.shipments (id) on delete set null,
  return_shipment_id   uuid references public.shipments (id) on delete set null,
  type                 public.return_type not null,
  reason               public.return_reason,
  status               public.return_status not null default 'expected',
  -- For an exchange: the replacement order that went out in its place.
  replacement_order_id uuid references public.orders (id) on delete set null,
  courier_reported_at  timestamptz,
  received_at          timestamptz,
  received_by          uuid references public.staff (id) on delete set null,
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index returns_order_idx on public.returns (order_id);
create index returns_status_idx on public.returns (status, created_at desc);
create index returns_reason_idx on public.returns (reason, created_at desc);

create trigger returns_touch_updated_at
  before update on public.returns
  for each row execute function public.touch_updated_at();

-- --- Return lines ----------------------------------------------------------
--
-- Per line and per quantity, because a customer here can open a parcel, keep
-- one item and hand the rest back. It is not common, but it happens, and an
-- order-level return could not express it.

create table public.return_lines (
  id                  uuid primary key default gen_random_uuid(),
  return_id           uuid not null references public.returns (id) on delete cascade,
  order_line_item_id  uuid references public.order_line_items (id) on delete set null,
  variant_id          uuid references public.variants (id) on delete restrict,
  sku                 text not null,
  quantity_expected   integer not null check (quantity_expected > 0),
  quantity_received   integer not null default 0 check (quantity_received >= 0),
  quantity_resellable integer not null default 0 check (quantity_resellable >= 0),
  quantity_damaged    integer not null default 0 check (quantity_damaged >= 0),
  -- Stored rather than derived so it can be indexed and alerted on. This is
  -- the number that says something went missing between the customer's door
  -- and our table.
  quantity_missing    integer generated always as (quantity_expected - quantity_received) stored,
  condition_note      text,
  created_at          timestamptz not null default now(),
  constraint return_lines_received_split
    check (quantity_resellable + quantity_damaged = quantity_received),
  constraint return_lines_not_over_received
    check (quantity_received <= quantity_expected)
);

create index return_lines_return_idx on public.return_lines (return_id);
create index return_lines_variant_idx on public.return_lines (variant_id);
create index return_lines_missing_idx on public.return_lines (quantity_missing)
  where quantity_missing > 0;

-- --- Creating a shipment ---------------------------------------------------

create or replace function public.record_shipment(
  p_order_id        uuid,
  p_tracking_number text,
  p_cod_amount_egp  numeric default null,
  p_service_type    text default null,
  p_zone            text default null,
  p_subzone         text default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.orders;
  v_shipment public.shipments;
  v_cod      numeric(12, 2);
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not create a shipment' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.fulfillment_status = 'cancelled' then
    raise exception 'Order % is cancelled', v_order.order_number
      using errcode = 'check_violation';
  end if;

  -- COD collects the goods plus the shipping the customer agreed to pay.
  -- A prepaid order collects nothing.
  v_cod := coalesce(
    p_cod_amount_egp,
    case when v_order.payment_method = 'cod'
         then v_order.total_egp + v_order.shipping_egp
         else 0 end
  );

  insert into public.shipments (
    order_id, tracking_number, direction, status,
    cod_amount_egp, service_type, zone, subzone
  )
  values (
    p_order_id, nullif(trim(p_tracking_number), ''), 'outbound', 'awaiting_pickup',
    v_cod, p_service_type, p_zone, p_subzone
  )
  returning * into v_shipment;

  update public.orders
     set fulfillment_status = 'awaiting_pickup'
   where id = p_order_id;

  return v_shipment;
end;
$$;

-- Handing the parcel to the daily pickup car. This is the moment custody
-- transfers, and the clock on the aged exception report starts here.
create or replace function public.mark_shipment_handed_over(p_shipment_id uuid)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not hand over a shipment' using errcode = 'insufficient_privilege';
  end if;

  update public.shipments
     set status = 'in_transit',
         handed_over_at = coalesce(handed_over_at, now())
   where id = p_shipment_id
  returning * into v_shipment;

  if not found then
    raise exception 'Shipment % not found', p_shipment_id using errcode = 'no_data_found';
  end if;

  if v_shipment.tracking_number is null then
    raise exception 'Shipment % has no tracking number. Record the courier code before handing it over.',
      p_shipment_id
      using errcode = 'check_violation',
            hint = 'A parcel with no tracking number cannot be chased if it goes missing.';
  end if;

  update public.orders set fulfillment_status = 'in_transit' where id = v_shipment.order_id;

  return v_shipment;
end;
$$;

-- --- A delivery that failed ------------------------------------------------

create or replace function public.record_delivery_failure(
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
  v_return   public.returns;
  v_shipment public.shipments;
  v_line     record;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not record a delivery failure' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if exists (select 1 from public.returns where order_id = p_order_id and status <> 'closed') then
    raise exception 'Order % already has an open return', v_order.order_number
      using errcode = 'unique_violation';
  end if;

  select * into v_shipment
    from public.shipments
   where order_id = p_order_id and direction = 'outbound'
   order by created_at desc limit 1;

  insert into public.returns (
    order_id, outbound_shipment_id, type, reason, status, courier_reported_at, note
  )
  values (
    p_order_id, v_shipment.id, 'failed_delivery', p_reason, 'expected', now(), p_note
  )
  returning * into v_return;

  -- Everything that went out is expected back. If only part of it comes, the
  -- shortfall shows up at check-in rather than being silently forgotten.
  for v_line in
    select id, variant_id, sku, quantity from public.order_line_items where order_id = p_order_id
  loop
    insert into public.return_lines (
      return_id, order_line_item_id, variant_id, sku, quantity_expected
    )
    values (v_return.id, v_line.id, v_line.variant_id, v_line.sku, v_line.quantity);
  end loop;

  if v_shipment.id is not null then
    update public.shipments
       set status = 'return_in_transit', failed_at = now()
     where id = v_shipment.id;
  end if;

  -- Still with the courier. No stock moves here - the goods are in a van.
  update public.orders set fulfillment_status = 'return_in_transit' where id = p_order_id;

  return v_return;
end;
$$;

-- --- Checking a return back in ---------------------------------------------

create or replace function public.receive_return(
  p_return_id uuid,
  p_lines     jsonb,
  p_note      text default null
)
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
  v_movements  jsonb := '[]'::jsonb;
  v_missing    integer := 0;
begin
  if not (public.has_any_role('admin', 'stock_manager', 'packing') or public.is_service_request()) then
    raise exception 'You may not check in a return' using errcode = 'insufficient_privilege';
  end if;

  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'Return % not found', p_return_id using errcode = 'no_data_found';
  end if;

  if v_return.status in ('received', 'closed') then
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

    update public.return_lines
       set quantity_received   = v_resellable + v_damaged,
           quantity_resellable = v_resellable,
           quantity_damaged    = v_damaged,
           condition_note      = v_item ->> 'condition_note'
     where id = v_line.id;

    -- Only what can actually be sold goes back into sellable stock. Damaged
    -- pieces are recorded on the line and simply never returned to stock -
    -- they were already deducted when the order went out, so the write-off is
    -- the absence of a movement rather than a second one.
    if v_resellable > 0 then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_line.variant_id,
        'quantity_delta', v_resellable
      );
    end if;
  end loop;

  select coalesce(sum(quantity_missing), 0) into v_missing
    from public.return_lines where return_id = p_return_id;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'return',
      p_movements       => v_movements,
      p_reference_type  => 'return',
      p_reference_id    => p_return_id::text,
      p_note            => p_note,
      p_idempotency_key => 'return:' || p_return_id::text
    );
  end if;

  update public.returns
     set status      = case when v_missing > 0 then 'discrepancy'::public.return_status
                            else 'received'::public.return_status end,
         received_at = now(),
         received_by = auth.uid(),
         note        = coalesce(p_note, note)
   where id = p_return_id
  returning * into v_return;

  -- The order closes only once the goods are physically accounted for.
  update public.orders
     set fulfillment_status = 'returned'
   where id = v_return.order_id;

  if v_return.outbound_shipment_id is not null then
    update public.shipments
       set status = 'returned', returned_at = now()
     where id = v_return.outbound_shipment_id;
  end if;

  return v_return;
end;
$$;

-- --- Exchanges -------------------------------------------------------------
--
-- Physically: the courier takes the replacement out on the daily run, swaps it
-- with the customer, and the original comes back to us batched with the other
-- returns on a later run. So it is two movements of goods that happen to share
-- one courier visit - modelled as a return plus a linked replacement order,
-- which keeps the stock ledger honest at both ends.

create or replace function public.create_exchange(
  p_order_id          uuid,
  p_return_lines      jsonb,
  p_replacement_items jsonb,
  p_reason            public.return_reason default 'wrong_size',
  p_note              text default null
)
returns public.returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order       public.orders;
  v_return      public.returns;
  v_replacement public.orders;
  v_item        jsonb;
  v_line        record;
begin
  if not (public.has_any_role('admin', 'stock_manager') or public.is_service_request()) then
    raise exception 'You may not create an exchange' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  insert into public.returns (order_id, type, reason, status, note)
  values (p_order_id, 'exchange', p_reason, 'expected', p_note)
  returning * into v_return;

  for v_item in select * from jsonb_array_elements(p_return_lines)
  loop
    select li.id, li.variant_id, li.sku into v_line
      from public.order_line_items li
     where li.id = (v_item ->> 'order_line_item_id')::uuid
       and li.order_id = p_order_id;

    if not found then
      raise exception 'Line % does not belong to order %',
        v_item ->> 'order_line_item_id', p_order_id
        using errcode = 'foreign_key_violation';
    end if;

    insert into public.return_lines (
      return_id, order_line_item_id, variant_id, sku, quantity_expected
    )
    values (
      v_return.id, v_line.id, v_line.variant_id, v_line.sku,
      (v_item ->> 'quantity')::integer
    );
  end loop;

  -- The replacement is an ordinary order, so it is packed, shipped, tracked
  -- and counted like any other. It carries no money: the customer already paid
  -- for the original.
  v_replacement := public.create_store_sale(
    p_location_id     => v_order.location_id,
    p_payment_method  => coalesce(v_order.payment_method, 'cash'),
    p_items           => p_replacement_items,
    p_idempotency_key => 'exchange:' || v_return.id::text,
    p_customer_id     => v_order.customer_id,
    p_discount_egp    => 0,
    p_note            => 'Exchange for ' || v_order.order_number,
    p_channel         => v_order.channel
  );

  update public.orders
     set fulfillment_status = 'ready_to_pack',
         total_egp          = 0,
         subtotal_egp       = 0,
         payment_status     = 'paid'
   where id = v_replacement.id;

  update public.returns
     set replacement_order_id = v_replacement.id
   where id = v_return.id
  returning * into v_return;

  return v_return;
end;
$$;

-- --- Permissions -----------------------------------------------------------

alter table public.shipments    enable row level security;
alter table public.returns      enable row level security;
alter table public.return_lines enable row level security;

create policy shipments_select on public.shipments
  for select to authenticated using ((select public.is_staff()));

create policy returns_select on public.returns
  for select to authenticated using ((select public.is_staff()));

create policy return_lines_select on public.return_lines
  for select to authenticated using ((select public.is_staff()));

grant select on public.shipments, public.returns, public.return_lines to authenticated;
grant all on public.shipments, public.returns, public.return_lines to service_role;

revoke execute on function public.record_shipment(uuid, text, numeric, text, text, text) from public, anon;
grant execute on function public.record_shipment(uuid, text, numeric, text, text, text) to authenticated, service_role;

revoke execute on function public.mark_shipment_handed_over(uuid) from public, anon;
grant execute on function public.mark_shipment_handed_over(uuid) to authenticated, service_role;

revoke execute on function public.record_delivery_failure(uuid, public.return_reason, text) from public, anon;
grant execute on function public.record_delivery_failure(uuid, public.return_reason, text) to authenticated, service_role;

revoke execute on function public.receive_return(uuid, jsonb, text) from public, anon;
grant execute on function public.receive_return(uuid, jsonb, text) to authenticated, service_role;

revoke execute on function public.create_exchange(uuid, jsonb, jsonb, public.return_reason, text) from public, anon;
grant execute on function public.create_exchange(uuid, jsonb, jsonb, public.return_reason, text) to authenticated, service_role;
