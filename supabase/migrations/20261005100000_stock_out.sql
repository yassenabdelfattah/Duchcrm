-- ---------------------------------------------------------------------------
-- Taking stock out for a reason, and knowing what has to come back.
--
-- The owner's ask (2026-10-04): move product out without making an order -
-- for a photoshoot, a gift, something damaged, or a reason typed in - so that
-- every piece that leaves the shelf can be traced. A piece that is coming
-- back (a photoshoot, typically) is tracked until it does.
--
-- Each stock-out is a document (stock_outs, with its lines) and a stock
-- movement of reason 'stock_out' per line, so the ledger stays the single
-- record of stock and Shopify drops the number as with any other change.
-- Bringing pieces back is a second movement, 'stock_out_return', against the
-- same document.
--
-- Taking out more than the system shows is refused, like a shop sale: the
-- CRM is deciding this one, and a wrong size or a typo should stop here
-- rather than drive the count negative. Who may do it: stock.adjust.
-- ---------------------------------------------------------------------------

alter type public.stock_movement_reason add value if not exists 'stock_out';
alter type public.stock_movement_reason add value if not exists 'stock_out_return';

create type public.stock_out_reason as enum ('photoshoot', 'gift', 'damaged', 'other');

create table public.stock_outs (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id),
  reason          public.stock_out_reason not null,
  -- The reason in words when it is none of the listed ones.
  reason_text     text,
  -- Who has the pieces: the photographer, the influencer, the factory.
  taken_by        text,
  note            text,
  expects_return  boolean not null default false,
  return_by       date,
  created_by      uuid references public.staff (id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Set when everything came back, or when someone decided the rest is not
  -- coming back. Never set for a stock-out that was not expected back.
  closed_at       timestamptz,
  closed_by       uuid references public.staff (id) on delete set null,
  close_note      text,
  idempotency_key text unique,
  constraint stock_outs_other_needs_text
    check (reason <> 'other' or nullif(trim(reason_text), '') is not null)
);

create table public.stock_out_lines (
  id                uuid primary key default gen_random_uuid(),
  stock_out_id      uuid not null references public.stock_outs (id) on delete cascade,
  variant_id        uuid not null references public.variants (id),
  quantity          integer not null check (quantity > 0),
  quantity_returned integer not null default 0,
  constraint stock_out_lines_returned_range
    check (quantity_returned >= 0 and quantity_returned <= quantity)
);

create index stock_out_lines_out_idx on public.stock_out_lines (stock_out_id);
create index stock_outs_open_idx on public.stock_outs (created_at desc) where closed_at is null;

comment on table public.stock_outs is
  'Stock taken off the shelf without an order, with a reason. Written only '
  'through record_stock_out(), return_stock_out() and close_stock_out().';

alter table public.stock_outs enable row level security;
alter table public.stock_out_lines enable row level security;

create policy stock_outs_select on public.stock_outs
  for select to authenticated
  using ((select public.has_permission('stock.read') or public.has_permission('stock.adjust')));

create policy stock_out_lines_select on public.stock_out_lines
  for select to authenticated
  using ((select public.has_permission('stock.read') or public.has_permission('stock.adjust')));

grant select on public.stock_outs, public.stock_out_lines to authenticated;
revoke insert, update, delete on public.stock_outs, public.stock_out_lines from authenticated, anon;

-- --- Who may move stock for these reasons ---------------------------------------------

create or replace function public.assert_can_move_stock(p_reason public.stock_movement_reason)
returns void
language plpgsql
stable
as $$
begin
  -- Edge Functions and the Worker use the service role key. They carry no end
  -- user, and they are the only callers allowed to record online_order and
  -- cancellation movements.
  if public.is_service_request() then
    return;
  end if;

  if not public.is_staff() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  if public.is_admin() then
    return;
  end if;

  case p_reason::text
    -- Selling at the counter.
    when 'store_sale' then
      if public.has_permission('sales.create') then return; end if;

    -- Goods physically back on the table and counted.
    when 'return' then
      if public.has_permission('returns.manage') then return; end if;

    -- Deciding a number should be different, booking in production, or
    -- taking pieces off the shelf for a reason.
    when 'adjustment', 'production_in', 'initial_import', 'wholesale', 'stock_out', 'stock_out_return' then
      if public.has_permission('stock.adjust') then return; end if;

    else
      null;
  end case;

  raise exception 'Role % may not record a % movement',
    coalesce(public.auth_role()::text, 'custom'), p_reason
    using errcode = 'insufficient_privilege';
end;
$$;

-- --- Taking out more than there is ------------------------------------------------------

create or replace function public.stock_movements_apply()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_quantity integer;
begin
  -- The ON CONFLICT DO UPDATE takes a row-level lock. A second transaction
  -- inserting a movement for the same variant and location blocks here until
  -- the first commits, then sees the first transaction's result. This is the
  -- mechanism that makes concurrent sales safe.
  insert into public.stock_levels as sl (variant_id, location_id, quantity, updated_at)
  values (new.variant_id, new.location_id, new.quantity_delta, now())
  on conflict (variant_id, location_id) do update
    set quantity   = sl.quantity + excluded.quantity,
        updated_at = now()
  returning sl.quantity into v_quantity;

  -- Reasons where the CRM is the gatekeeper: we are being asked to approve a
  -- sale or a stock-out, so we refuse one we cannot supply.
  --
  -- Reasons NOT listed here (online_order, return, cancellation, adjustment,
  -- production_in, initial_import, stock_out_return) record something that
  -- already happened somewhere else. Rejecting those would mean throwing away
  -- the record and leaving the ledger less accurate, not more - so they are
  -- allowed through and the resulting negative is surfaced as a sync issue.
  if v_quantity < 0 and new.reason::text in ('store_sale', 'wholesale', 'stock_out') then
    raise exception 'insufficient_stock: variant % at location % would go to %',
      new.variant_id, new.location_id, v_quantity
      using errcode = 'check_violation',
            hint = 'insufficient_stock';
  end if;

  return new;
end;
$$;

-- --- Taking stock out ----------------------------------------------------------------------

create or replace function public.record_stock_out(
  p_location_id     uuid,
  p_reason          public.stock_out_reason,
  p_reason_text     text,
  p_items           jsonb,
  p_taken_by        text,
  p_note            text,
  p_expects_return  boolean,
  p_return_by       date,
  p_idempotency_key text
)
returns public.stock_outs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out        public.stock_outs;
  v_location   uuid;
  v_item       jsonb;
  v_variant    uuid;
  v_quantity   integer;
  v_movements  jsonb := '[]'::jsonb;
  v_label      text;
begin
  if not (public.has_permission('stock.adjust') or public.is_service_request()) then
    raise exception 'You may not take stock out' using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A second tap returns the first stock-out rather than taking the pieces
  -- out twice.
  select * into v_out from public.stock_outs where idempotency_key = p_idempotency_key;
  if found then
    return v_out;
  end if;

  if p_reason = 'other' and nullif(trim(p_reason_text), '') is null then
    raise exception 'Say why the stock is going out' using errcode = 'invalid_parameter_value';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to take out' using errcode = 'invalid_parameter_value';
  end if;

  v_location := coalesce(
    p_location_id,
    (select id from public.locations where is_default and is_active limit 1)
  );
  if v_location is null then
    raise exception 'No default location is configured to ship from' using errcode = 'no_data_found';
  end if;

  insert into public.stock_outs (
    location_id, reason, reason_text, taken_by, note, expects_return, return_by,
    created_by, idempotency_key
  )
  values (
    v_location,
    p_reason,
    case when p_reason = 'other' then trim(p_reason_text) else nullif(trim(p_reason_text), '') end,
    nullif(trim(p_taken_by), ''),
    nullif(trim(p_note), ''),
    coalesce(p_expects_return, false),
    case when coalesce(p_expects_return, false) then p_return_by end,
    auth.uid(),
    p_idempotency_key
  )
  returning * into v_out;

  -- The same item listed twice is one line with the two quantities added.
  for v_variant, v_quantity in
    select (i ->> 'variant_id')::uuid, sum((i ->> 'quantity')::integer)::integer
      from jsonb_array_elements(p_items) i
     group by 1
  loop
    if not exists (select 1 from public.variants where id = v_variant) then
      raise exception 'Unknown variant %', v_variant using errcode = 'no_data_found';
    end if;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Quantity for % must be a positive whole number',
        (select sku from public.variants where id = v_variant)
        using errcode = 'invalid_parameter_value';
    end if;

    insert into public.stock_out_lines (stock_out_id, variant_id, quantity)
    values (v_out.id, v_variant, v_quantity);

    v_movements := v_movements || jsonb_build_object('variant_id', v_variant, 'quantity_delta', -v_quantity);
  end loop;

  -- What the ledger line says, so the movement log reads on its own.
  v_label := concat_ws(' · ',
    coalesce(v_out.reason_text, v_out.reason::text),
    v_out.taken_by,
    v_out.note);

  perform public.record_stock_movements(
    p_location_id     => v_location,
    p_reason          => 'stock_out',
    p_movements       => v_movements,
    p_reference_type  => 'stock_out',
    p_reference_id    => v_out.id::text,
    p_note            => v_label,
    p_idempotency_key => 'stock-out:' || v_out.id::text
  );

  return v_out;
end;
$$;

-- --- Pieces coming back ---------------------------------------------------------------------

create or replace function public.return_stock_out(
  p_stock_out_id uuid,
  p_items        jsonb,
  p_note         text default null
)
returns public.stock_outs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out       public.stock_outs;
  v_line      public.stock_out_lines;
  v_item      jsonb;
  v_quantity  integer;
  v_movements jsonb := '[]'::jsonb;
begin
  if not (public.has_permission('stock.adjust') or public.is_service_request()) then
    raise exception 'You may not take stock out' using errcode = 'insufficient_privilege';
  end if;

  select * into v_out from public.stock_outs where id = p_stock_out_id for update;
  if not found then
    raise exception 'Stock-out % not found', p_stock_out_id using errcode = 'no_data_found';
  end if;

  if v_out.closed_at is not null then
    raise exception 'This stock-out is already closed' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    continue when v_quantity = 0;

    select * into v_line
      from public.stock_out_lines
     where id = (v_item ->> 'line_id')::uuid
       and stock_out_id = p_stock_out_id
     for update;
    if not found then
      raise exception 'Line % is not part of this stock-out', v_item ->> 'line_id'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_quantity < 0 or v_line.quantity_returned + v_quantity > v_line.quantity then
      raise exception 'More is coming back than went out'
        using errcode = 'check_violation';
    end if;

    update public.stock_out_lines
       set quantity_returned = quantity_returned + v_quantity
     where id = v_line.id;

    v_movements := v_movements || jsonb_build_object('variant_id', v_line.variant_id, 'quantity_delta', v_quantity);
  end loop;

  if jsonb_array_length(v_movements) = 0 then
    raise exception 'Choose at least one item that came back' using errcode = 'invalid_parameter_value';
  end if;

  perform public.record_stock_movements(
    p_location_id    => v_out.location_id,
    p_reason         => 'stock_out_return',
    p_movements      => v_movements,
    p_reference_type => 'stock_out',
    p_reference_id   => v_out.id::text,
    p_note           => nullif(trim(p_note), '')
  );

  -- Everything back: nothing left to wait for.
  if not exists (select 1 from public.stock_out_lines
                  where stock_out_id = p_stock_out_id and quantity_returned < quantity) then
    update public.stock_outs
       set closed_at = now(), closed_by = auth.uid(), close_note = coalesce(nullif(trim(p_note), ''), close_note)
     where id = p_stock_out_id;
  end if;

  select * into v_out from public.stock_outs where id = p_stock_out_id;
  return v_out;
end;
$$;

-- --- Not coming back after all ------------------------------------------------------------------

create or replace function public.close_stock_out(p_stock_out_id uuid, p_note text default null)
returns public.stock_outs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out public.stock_outs;
begin
  if not (public.has_permission('stock.adjust') or public.is_service_request()) then
    raise exception 'You may not take stock out' using errcode = 'insufficient_privilege';
  end if;

  select * into v_out from public.stock_outs where id = p_stock_out_id for update;
  if not found then
    raise exception 'Stock-out % not found', p_stock_out_id using errcode = 'no_data_found';
  end if;

  if v_out.closed_at is not null then
    return v_out;
  end if;

  -- The pieces already left stock when they went out; deciding they are not
  -- coming back moves nothing. It only stops the wait.
  update public.stock_outs
     set closed_at = now(), closed_by = auth.uid(), close_note = nullif(trim(p_note), '')
   where id = p_stock_out_id
  returning * into v_out;

  return v_out;
end;
$$;

revoke execute on function public.record_stock_out(uuid, public.stock_out_reason, text, jsonb, text, text, boolean, date, text) from public, anon;
grant execute on function public.record_stock_out(uuid, public.stock_out_reason, text, jsonb, text, text, boolean, date, text) to authenticated, service_role;
revoke execute on function public.return_stock_out(uuid, jsonb, text) from public, anon;
grant execute on function public.return_stock_out(uuid, jsonb, text) to authenticated, service_role;
revoke execute on function public.close_stock_out(uuid, text) from public, anon;
grant execute on function public.close_stock_out(uuid, text) to authenticated, service_role;

-- --- The list ---------------------------------------------------------------------------------------

create or replace view public.v_stock_outs
with (security_invoker = on) as
select
  so.id,
  so.reason,
  so.reason_text,
  so.taken_by,
  so.note,
  so.expects_return,
  so.return_by,
  so.created_at,
  so.closed_at,
  so.close_note,
  s.full_name                          as created_by_name,
  case
    when li.outstanding = 0 then 'returned'
    when not so.expects_return then 'gone'
    when so.closed_at is null and so.return_by is not null and so.return_by < current_date then 'overdue'
    when so.closed_at is null then 'out'
    else 'kept'
  end                                  as status,
  li.quantity                          as quantity,
  li.outstanding                       as outstanding,
  li.lines                             as lines
from public.stock_outs so
left join public.staff s on s.id = so.created_by
left join lateral (
  select
    sum(l.quantity)::int                         as quantity,
    sum(l.quantity - l.quantity_returned)::int   as outstanding,
    jsonb_agg(
      jsonb_build_object(
        'id', l.id,
        'sku', v.sku,
        'title', p.title,
        'size', v.size,
        'color', v.color,
        'quantity', l.quantity,
        'returned', l.quantity_returned
      )
      order by v.sku
    )                                            as lines
  from public.stock_out_lines l
  join public.variants v on v.id = l.variant_id
  join public.products p on p.id = v.product_id
  where l.stock_out_id = so.id
) li on true;

comment on view public.v_stock_outs is
  'Each stock-out with its lines and where it stands: returned (all back), gone '
  '(not expected back), out, overdue, or kept (closed with pieces still out).';

grant select on public.v_stock_outs to authenticated;
