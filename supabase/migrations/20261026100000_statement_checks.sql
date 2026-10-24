-- Statements: a mismatch is flagged, a closed one can be reopened (2026-10-26).
--
-- Found on the first two of Accurate's statements:
--   * #1413 is on CSHP--029988 as returned, with a 130 fee, and the CRM still
--     has it with the courier: nobody has scanned it back in, so its piece is
--     not on the shelf. #1414 is on the same statement as returned, and the
--     CRM has it delivered and paid. Neither was pointed out. Each statement
--     line now says when what Accurate wrote and what the CRM knows disagree.
--   * A statement once closed could not be touched again, so a line entered
--     wrong stayed wrong. It can now be reopened. The orders its review marked
--     paid stay paid - each line remembers whether it was the one that did it
--     - and only go back to unpaid if their line is taken off, or changed to a
--     return.
--   * D2610-00017 went with our own driver and came back. It has been waiting
--     for Accurate's statement for three weeks; Accurate will never list it.
--   * A parcel paid online (#1414, InstaPay) had no right way onto a
--     statement. Accurate collected nothing and charged its shipping, but a
--     delivered line expected the goods - so it went on as a return to get a
--     zero. A delivery with nothing to collect now expects nothing; its fee is
--     what Accurate charged to carry it, and its products stay off the
--     accountant's list, since that money came in online and not in this
--     transfer.

-- --- Which lines paid their order ----------------------------------------------------

alter table public.settlement_lines
  add column marked_paid boolean not null default false;

comment on column public.settlement_lines.marked_paid is
  'This statement''s review is what marked the order paid. Taking the line off '
  'a reopened statement makes the order unpaid again; an order paid some other '
  'way is left alone.';

-- The two statements already closed. Their review ran in one transaction, so
-- every payment it made is stamped with exactly the statement's reviewed_at.
update public.settlement_lines sl
   set marked_paid = true
  from public.courier_settlements s
 where s.id = sl.settlement_id
   and s.reviewed_at is not null
   and sl.outcome = 'delivered'
   and exists (
     select 1 from public.order_events e
      where e.order_id = sl.order_id
        and e.to_payment = 'paid'
        and e.created_at = s.reviewed_at
   );

alter table public.courier_settlements
  add column reopened_at timestamptz,
  add column reopened_by uuid references public.staff (id) on delete set null;

-- --- Closing --------------------------------------------------------------------------

create or replace function public.review_settlement(p_settlement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settlement public.courier_settlements;
  v_lines_net  numeric(12, 2);
  v_paid       integer := 0;
  v_unmatched  integer;
  v_difference numeric(12, 2);
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may review a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_settlement
    from public.courier_settlements where id = p_settlement_id for update;

  if not found then
    raise exception 'Settlement % not found', p_settlement_id using errcode = 'no_data_found';
  end if;

  if v_settlement.status <> 'draft' then
    raise exception 'Settlement % has already been reviewed', v_settlement.reference
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(net_egp), 0),
         count(*) filter (where order_id is null and outcome <> 'adjustment')
    into v_lines_net, v_unmatched
    from public.settlement_lines where settlement_id = p_settlement_id;

  v_difference := coalesce(v_settlement.net_received_egp, v_lines_net) - v_lines_net;

  -- Money the courier says they sent must equal the lines that explain it.
  -- Refusing to close on a mismatch is the point: an unexplained difference is
  -- exactly the thing that would otherwise be shrugged off and forgotten.
  if abs(v_difference) > 0.009 then
    raise exception
      'Settlement does not balance: the bank received %, the lines add up to %, a difference of %',
      v_settlement.net_received_egp, v_lines_net, v_difference
      using errcode = 'check_violation',
            hint = 'settlement_out_of_balance';
  end if;

  -- Delivered and paid for. This is the only place an order becomes paid from
  -- the courier's cash, which is what keeps "delivered" and "we have the
  -- money" honestly separate. The line remembers it did it, for a reopening.
  with paid as (
    update public.orders o
       set payment_status = 'paid'
      from public.settlement_lines sl
     where sl.settlement_id = p_settlement_id
       and sl.order_id = o.id
       and sl.outcome = 'delivered'
       -- A parcel paid online brought no cash in; Accurate's transfer is not
       -- what proves it paid.
       and sl.collected_egp > 0
       and o.payment_status = 'pending'
    returning o.id
  )
  update public.settlement_lines sl
     set marked_paid = true
    from paid
   where sl.settlement_id = p_settlement_id
     and sl.order_id = paid.id;

  get diagnostics v_paid = row_count;

  update public.courier_settlements
     set status = 'reviewed', reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_settlement_id;

  return jsonb_build_object(
    'settlement_id', p_settlement_id,
    'orders_marked_paid', v_paid,
    'unmatched_lines', v_unmatched,
    'net_egp', v_lines_net
  );
end;
$$;

-- --- Reopening --------------------------------------------------------------------------

create or replace function public.reopen_settlement(p_settlement_id uuid)
returns public.courier_settlements
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settlement public.courier_settlements;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may reopen a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_settlement
    from public.courier_settlements where id = p_settlement_id for update;

  if not found then
    raise exception 'Settlement % not found', p_settlement_id using errcode = 'no_data_found';
  end if;

  if v_settlement.status = 'draft' then
    raise exception 'Settlement % is already open', v_settlement.reference
      using errcode = 'check_violation', hint = 'settlement_already_open';
  end if;

  -- Open for correcting, not undone: what it marked paid stays paid until its
  -- line is taken off or changed, and closing it again still has to balance.
  update public.courier_settlements
     set status      = 'draft',
         reviewed_by = null,
         reviewed_at = null,
         reopened_at = now(),
         reopened_by = auth.uid()
   where id = p_settlement_id
  returning * into v_settlement;

  return v_settlement;
end;
$$;

comment on function public.reopen_settlement(uuid) is
  'Opens a closed statement for correcting. Orders it marked paid stay paid '
  'unless their line is removed or turned into a return.';

revoke execute on function public.reopen_settlement(uuid) from public, anon;
grant execute on function public.reopen_settlement(uuid) to authenticated, service_role;

-- --- What a delivered parcel brings in --------------------------------------------------------

-- The goods, after discount - not cod_amount_egp, which includes the shipping
-- the customer pays at the door and Accurate keeps. Nothing, when there was
-- nothing to collect at the door: paid online, the goods' money came in
-- before the parcel left.
create or replace function public.settlement_goods(p_shipment_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when sh.cod_amount_egp = 0 then 0 else o.total_egp end
    from public.shipments sh
    join public.orders o on o.id = sh.order_id
   where sh.id = p_shipment_id;
$$;

revoke execute on function public.settlement_goods(uuid) from public, anon;
grant execute on function public.settlement_goods(uuid) to authenticated, service_role;

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
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
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

  v_expected := public.settlement_goods(v_shipment.id);

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

-- What the parcel being chosen is, before it goes on: now including whether
-- it was paid online, and expecting what a line would.
create or replace function public.lookup_shipment_for_settlement(p_tracking text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_customer public.customers;
  v_settled  record;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may read settlements'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('found', false, 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Already on a statement. Worth knowing before it is keyed a second time.
  select s.reference, s.id into v_settled
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.order_id = v_order.id
   limit 1;

  return jsonb_build_object(
    'found', true,
    'tracking_number', v_shipment.tracking_number,
    'order_number', v_order.order_number,
    'fulfillment_status', v_order.fulfillment_status,
    'payment_status', v_order.payment_status,
    'payment_method', v_order.payment_method,
    'prepaid', v_shipment.cod_amount_egp = 0,
    'customer_name', v_customer.full_name,
    'governorate', v_customer.governorate,
    'goods_egp', v_order.total_egp,
    'shipping_egp', v_order.shipping_egp,
    'expected_egp', public.settlement_goods(v_shipment.id),
    'already_on', v_settled.reference,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity,
               'unit_price_egp', li.unit_price_egp,
               'total_egp', li.total_egp
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       where li.order_id = v_order.id
    )
  );
end;
$$;

-- The accountant's products and breakdown: only the deliveries that brought
-- money into this transfer.
create or replace view public.v_settlement_products
with (security_invoker = on) as
select
  sl.settlement_id,
  li.title,
  li.unit_price_egp,
  sum(li.quantity)::integer as quantity,
  sum(li.total_egp)         as total_egp
from public.settlement_lines sl
join public.order_line_items li on li.order_id = sl.order_id
-- Only the deliveries. A refused parcel brought no money in; it appears among
-- the deductions instead. Nor did one paid online.
where sl.outcome = 'delivered'
  and sl.collected_egp > 0
group by sl.settlement_id, li.title, li.unit_price_egp;

create or replace view public.v_settlement_breakdown as
select
  sl.settlement_id,
  coalesce(sum(o.total_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0) as goods_egp,
  coalesce(sum(sl.collected_egp), 0) as collected_egp,
  coalesce(sum(sl.fee_egp), 0) as fees_egp,
  coalesce(sum(sl.net_egp), 0) as net_egp,
  -- What the courier says they collected, against what the goods were worth.
  -- Anything other than zero means a parcel was collected for the wrong
  -- amount, which is worth seeing rather than averaging away.
  coalesce(sum(sl.collected_egp), 0)
    - coalesce(sum(o.total_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    as collection_difference_egp
from public.settlement_lines sl
left join public.orders o on o.id = sl.order_id
group by sl.settlement_id;

-- --- Correcting a line --------------------------------------------------------------------

-- An order this statement marked paid, whose delivery is no longer on it: we
-- do not have its money on this statement any more.
create or replace function public.unpay_settlement_line(p_line public.settlement_lines)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not p_line.marked_paid or p_line.order_id is null then
    return;
  end if;

  -- The status trigger writes the order's history, with who did it.
  update public.orders
     set payment_status = 'pending'
   where id = p_line.order_id
     and payment_status = 'paid';
end;
$$;

revoke execute on function public.unpay_settlement_line(public.settlement_lines) from public, anon, authenticated;

create or replace function public.remove_settlement_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.settlement_lines;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may edit a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  select sl.* into v_line
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.id = p_line_id and s.status = 'draft'
     for update of sl;

  if not found then
    raise exception 'That settlement has already been reviewed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  perform public.unpay_settlement_line(v_line);
  delete from public.settlement_lines where id = p_line_id;
end;
$$;

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
  v_line  public.settlement_lines;
  v_goods numeric(12, 2);
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may edit a settlement'
      using errcode = 'insufficient_privilege';
  end if;

  select sl.* into v_line
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.id = p_line_id and s.status = 'draft'
     for update of sl;

  if not found then
    raise exception 'That settlement has already been reviewed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  v_goods := public.settlement_goods(v_line.shipment_id);

  -- A delivery that turns out to have been a return brought in no money.
  if p_outcome is not null and p_outcome <> 'delivered' and v_line.marked_paid then
    perform public.unpay_settlement_line(v_line);
    v_line.marked_paid := false;
  end if;

  -- Turned into a return or a delivery with no amount given, it is filled in
  -- as a new line would be: nothing collected on a return, the goods on a
  -- delivery.
  update public.settlement_lines
     set outcome       = coalesce(p_outcome, outcome),
         collected_egp = coalesce(
                           p_collected_egp,
                           case
                             when p_outcome is null or p_outcome = outcome then collected_egp
                             when p_outcome = 'delivered' then coalesce(v_goods, expected_egp, 0)
                             else 0
                           end),
         fee_egp       = coalesce(p_fee_egp, fee_egp),
         -- Left out keeps the note; sent empty clears it.
         note          = case when p_note is null then note else nullif(trim(p_note), '') end,
         marked_paid   = v_line.marked_paid
   where id = p_line_id
  returning * into v_line;

  return v_line;
end;
$$;

-- --- What Accurate wrote against what the CRM knows ------------------------------------------

-- Appended at the end: CREATE OR REPLACE VIEW can only add columns.
create or replace view public.v_settlement_statement
with (security_invoker = on) as
select
  s.id as settlement_id,
  s.reference,
  s.received_at,
  s.status,
  sl.id as line_id,
  sl.tracking_number,
  sl.outcome,
  sl.collected_egp,
  sl.fee_egp,
  sl.net_egp,
  o.order_number,
  c.full_name as customer_name,
  c.governorate,
  (
    select string_agg(li.title || ' ×' || li.quantity, ', ' order by li.title)
      from public.order_line_items li
     where li.order_id = sl.order_id
  ) as items,
  sl.note,
  sl.order_id,
  o.fulfillment_status as order_status,
  -- Null when they agree:
  --   not_back          returned on the statement, not checked in on Returns
  --   crm_delivered     returned on the statement, delivered in the CRM
  --   crm_returned      delivered on the statement, returned in the CRM
  --   crm_not_delivered delivered on the statement, still out in the CRM
  case
    when o.id is null then null
    when sl.outcome = 'delivered' then
      case
        when o.fulfillment_status = 'delivered' then null
        when o.fulfillment_status in ('returned', 'return_in_transit') then 'crm_returned'
        else 'crm_not_delivered'
      end
    when sl.outcome in ('returned_refused', 'returned_no_response', 'returned_other') then
      case
        -- Cancelled before the courier took it: the goods never left.
        when o.fulfillment_status in ('returned', 'cancelled') then null
        when o.fulfillment_status = 'delivered' then 'crm_delivered'
        else 'not_back'
      end
  end as mismatch,
  sl.marked_paid
from public.courier_settlements s
join public.settlement_lines sl on sl.settlement_id = s.id
left join public.orders o on o.id = sl.order_id
left join public.customers c on c.id = o.customer_id;

-- --- Our own driver is not on Accurate's statement ------------------------------------------

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
  and s.courier <> 'own'
  and s.status <> 'cancelled'
  and not exists (
    select 1 from public.settlement_lines sl where sl.order_id = o.id
  );
