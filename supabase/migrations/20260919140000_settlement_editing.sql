-- ---------------------------------------------------------------------------
-- Phase 3: working through a courier statement.
--
-- The statement is typed in by hand with the courier's version open alongside,
-- which means mistakes while typing are normal and have to be correctable. A
-- settlement in draft can have lines added, corrected and removed; once it is
-- reviewed it is closed, because by then it has marked orders paid.
-- ---------------------------------------------------------------------------

-- --- The list of statements ------------------------------------------------

create or replace view public.v_settlements
with (security_invoker = on) as
select
  s.id,
  s.courier,
  s.reference,
  s.statement_date,
  s.received_at,
  s.net_received_egp,
  s.status,
  s.note,
  s.reviewed_at,
  st.full_name                       as reviewed_by_name,
  coalesce(t.line_count, 0)          as line_count,
  coalesce(t.delivered_count, 0)     as delivered_count,
  coalesce(t.return_count, 0)        as return_count,
  coalesce(t.collected_egp, 0)       as collected_egp,
  coalesce(t.fees_egp, 0)            as fees_egp,
  coalesce(t.net_egp, 0)             as net_egp,
  coalesce(t.difference_egp, 0)      as difference_egp,
  coalesce(t.unmatched_lines, 0)     as unmatched_lines
from public.courier_settlements s
left join public.v_settlement_totals t on t.settlement_id = s.id
left join public.staff st on st.id = s.reviewed_by;

grant select on public.v_settlements to authenticated;

-- --- Correcting a line -----------------------------------------------------

create or replace function public.update_settlement_line(
  p_line_id       uuid,
  p_outcome       public.settlement_outcome default null,
  p_collected_egp numeric default null,
  p_fee_egp       numeric default null,
  p_note          text default null
)
returns public.settlement_lines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.settlement_lines;
begin
  if not (public.is_admin() or public.has_any_role('stock_manager') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may edit a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements s
      join public.settlement_lines sl on sl.settlement_id = s.id
     where sl.id = p_line_id and s.status = 'draft'
  ) then
    raise exception 'That settlement has already been reviewed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  update public.settlement_lines
     set outcome       = coalesce(p_outcome, outcome),
         collected_egp = coalesce(p_collected_egp, collected_egp),
         fee_egp       = coalesce(p_fee_egp, fee_egp),
         note          = coalesce(p_note, note)
   where id = p_line_id
  returning * into v_line;

  return v_line;
end;
$$;

create or replace function public.remove_settlement_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_admin() or public.has_any_role('stock_manager') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may edit a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements s
      join public.settlement_lines sl on sl.settlement_id = s.id
     where sl.id = p_line_id and s.status = 'draft'
  ) then
    raise exception 'That settlement has already been reviewed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  delete from public.settlement_lines where id = p_line_id;
end;
$$;

-- --- A clearer error for the same parcel entered twice ---------------------
--
-- Working down a paper statement, the most likely mistake is keying the same
-- code twice. The unique index catches it; this turns the constraint name into
-- something that tells you what happened.

create or replace function public.add_settlement_line(
  p_settlement_id   uuid,
  p_tracking_number text,
  p_outcome         public.settlement_outcome,
  p_collected_egp   numeric default null,
  p_fee_egp         numeric default 0,
  p_note            text default null
)
returns public.settlement_lines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment  public.shipments;
  v_order     public.orders;
  v_line      public.settlement_lines;
  v_expected  numeric(12, 2);
  v_collected numeric(12, 2);
begin
  if not (public.is_admin() or public.has_any_role('stock_manager') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may enter a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.courier_settlements
     where id = p_settlement_id and status = 'draft'
  ) then
    raise exception 'Settlement % is not open for editing', p_settlement_id
      using errcode = 'check_violation';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking_number)
   order by created_at desc
   limit 1;

  -- Run unconditionally rather than inside an "if found", so v_order is always
  -- assigned - to a row, or to nulls. A line whose code matches nothing is
  -- still recorded, and shows up as unmatched on the settlement total.
  select * into v_order from public.orders where id = v_shipment.order_id;

  v_expected := v_shipment.cod_amount_egp;

  if v_order.id is not null and exists (
    select 1 from public.settlement_lines
     where settlement_id = p_settlement_id and order_id = v_order.id
  ) then
    raise exception '% is already on this statement', v_order.order_number
      using errcode = 'unique_violation', hint = 'duplicate_settlement_line';
  end if;

  -- Pre-fill from what we already know, so a normal delivered line needs no
  -- typing beyond the code itself.
  v_collected := coalesce(
    p_collected_egp,
    case when p_outcome = 'delivered' then coalesce(v_expected, 0) else 0 end
  );

  insert into public.settlement_lines (
    settlement_id, order_id, shipment_id, tracking_number,
    outcome, collected_egp, fee_egp, expected_egp, note
  )
  values (
    p_settlement_id, v_order.id, v_shipment.id, trim(p_tracking_number),
    p_outcome, v_collected, coalesce(p_fee_egp, 0), v_expected, p_note
  )
  returning * into v_line;

  return v_line;
end;
$$;

-- --- What is still owed to us ----------------------------------------------
--
-- Deliveries that have not turned up on any statement yet. Working from this
-- rather than only from the courier's paper is what catches an order they
-- delivered and quietly never paid for.

create or replace view public.v_awaiting_settlement
with (security_invoker = on) as
select
  o.id                as order_id,
  o.order_number,
  o.fulfillment_status,
  o.total_egp,
  o.shipping_egp,
  s.tracking_number,
  s.cod_amount_egp,
  s.delivered_at,
  s.returned_at,
  coalesce(s.delivered_at, s.returned_at, s.handed_over_at) as settled_from,
  extract(epoch from (now() - coalesce(s.delivered_at, s.returned_at, s.handed_over_at))) / 86400
                      as days_waiting,
  c.full_name         as customer_name,
  c.governorate
from public.orders o
join public.shipments s on s.order_id = o.id and s.direction = 'outbound'
left join public.customers c on c.id = o.customer_id
where o.fulfillment_status in ('delivered', 'returned')
  and o.payment_status = 'pending'
  and not exists (
    select 1 from public.settlement_lines sl where sl.order_id = o.id
  );

comment on view public.v_awaiting_settlement is
  'Parcels the courier has finished with that have not appeared on a statement '
  'yet. A row here older than their usual remittance cycle is money to chase.';

grant select on public.v_awaiting_settlement to authenticated;

revoke execute on function public.update_settlement_line(uuid, public.settlement_outcome, numeric, numeric, text) from public, anon;
grant execute on function public.update_settlement_line(uuid, public.settlement_outcome, numeric, numeric, text) to authenticated, service_role;

revoke execute on function public.remove_settlement_line(uuid) from public, anon;
grant execute on function public.remove_settlement_line(uuid) to authenticated, service_role;
