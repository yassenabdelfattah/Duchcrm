-- A statement line reads like Accurate's (2026-10-27).
--
-- Accurate's statement (their portal, CSHP--029988) lists each parcel with
-- قيمة التسليم - what they collected at the door, the goods and the shipping
-- the customer paid - then الرسوم المستحقة, what they charge us to carry it,
-- and المستحق, the one less the other. A delivered line here expected only the
-- goods with nothing charged, which agreed with their net only when the
-- customer paid exactly what Accurate charged. Five parcels on that statement
-- did not (paid 90, charged 95; paid 150, charged 130), and each was worked out
-- by hand and typed in as one figure, the difference lost.
--
-- Now a delivered line is entered in their columns: collected, fee, and the net
-- between them. Both are filled in from the order - what the courier was given
-- to collect, and the shipping the customer was charged - so a parcel where
-- they agree still needs nothing typed, and one where Accurate charged
-- differently is a fee corrected in place, its gain or loss on the shipping
-- kept. The statement's totals are then theirs, column for column.
--
-- Lines entered before stay as they were. They carry no customer shipping,
-- and every total reads them as before.

alter table public.settlement_lines
  add column customer_shipping_egp numeric(12, 2);

comment on column public.settlement_lines.customer_shipping_egp is
  'The shipping the customer paid Accurate at the door for this parcel - 0 when '
  'paid online - as it stood when the line was entered. Its collected amount '
  'includes it, and its fee is what Accurate charged instead. Null on lines '
  'entered before 2026-10-27, whose collected amount is the goods alone.';

-- What the customer pays the courier for shipping at the door: nothing when
-- the parcel was paid for online.
create or replace function public.settlement_door_shipping(p_shipment_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when sh.cod_amount_egp = 0 then 0 else o.shipping_egp end
    from public.shipments sh
    join public.orders o on o.id = sh.order_id
   where sh.id = p_shipment_id;
$$;

revoke execute on function public.settlement_door_shipping(uuid) from public, anon;
grant execute on function public.settlement_door_shipping(uuid) to authenticated, service_role;

-- --- Entering a line ----------------------------------------------------------------------

create or replace function public.add_settlement_line(
  p_settlement_id   uuid,
  p_tracking_number text,
  p_outcome         public.settlement_outcome,
  p_collected_egp   numeric default null,
  p_fee_egp         numeric default null,
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
  v_shipping  numeric(12, 2);
  v_collected numeric(12, 2);
  v_fee       numeric(12, 2);
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
  v_shipping := public.settlement_door_shipping(v_shipment.id);

  if v_order.id is not null and exists (
    select 1 from public.settlement_lines
     where settlement_id = p_settlement_id and order_id = v_order.id
  ) then
    raise exception '% is already on this statement', v_order.order_number
      using errcode = 'unique_violation', hint = 'duplicate_settlement_line';
  end if;

  -- Filled in as Accurate's statement should read, so a normal delivery needs
  -- nothing typed: they collected the goods and the shipping, and charged the
  -- shipping. A return collected nothing; its fee is theirs to say.
  v_collected := coalesce(
    p_collected_egp,
    case when p_outcome = 'delivered' then coalesce(v_expected, 0) + coalesce(v_shipping, 0) else 0 end
  );
  v_fee := coalesce(
    p_fee_egp,
    case when p_outcome = 'delivered' then coalesce(v_order.shipping_egp, 0) else 0 end
  );

  insert into public.settlement_lines (
    settlement_id, order_id, shipment_id, tracking_number,
    outcome, collected_egp, fee_egp, expected_egp, customer_shipping_egp, note
  )
  values (
    p_settlement_id, v_order.id, v_shipment.id, trim(p_tracking_number),
    p_outcome, v_collected, v_fee, v_expected, v_shipping, p_note
  )
  returning * into v_line;

  return v_line;
end;
$$;

-- --- Correcting a line --------------------------------------------------------------------

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
  -- as a new line would be: nothing collected on a return; on a delivery the
  -- goods, and the shipping too on a line that records it.
  update public.settlement_lines
     set outcome       = coalesce(p_outcome, outcome),
         collected_egp = coalesce(
                           p_collected_egp,
                           case
                             when p_outcome is null or p_outcome = outcome then collected_egp
                             when p_outcome = 'delivered'
                               then coalesce(v_goods, expected_egp, 0) + coalesce(customer_shipping_egp, 0)
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

-- --- Checking a parcel before it goes on ----------------------------------------------------

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
    -- What their statement should say for it, delivered: collected at the
    -- door, and charged to carry it - the shipping the customer was charged.
    'expected_egp', public.settlement_goods(v_shipment.id) + public.settlement_door_shipping(v_shipment.id),
    'door_shipping_egp', public.settlement_door_shipping(v_shipment.id),
    'fee_egp', v_order.shipping_egp,
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

-- --- The totals ---------------------------------------------------------------------------

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
  sl.marked_paid,
  sl.customer_shipping_egp,
  -- On a delivery the customer paid shipping at the door for: what that
  -- shipping made or lost against what Accurate charged.
  case
    when sl.outcome = 'delivered' and sl.customer_shipping_egp > 0
      then sl.customer_shipping_egp - sl.fee_egp
  end as shipping_gain_egp
from public.courier_settlements s
join public.settlement_lines sl on sl.settlement_id = s.id
left join public.orders o on o.id = sl.order_id
left join public.customers c on c.id = o.customer_id;

-- The customer's shipping is in what was collected, so it comes out of the
-- collection difference - or every delivery would show its shipping as one.
create or replace view public.v_settlement_breakdown as
select
  sl.settlement_id,
  coalesce(sum(o.total_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0) as goods_egp,
  coalesce(sum(sl.collected_egp), 0) as collected_egp,
  coalesce(sum(sl.fee_egp), 0) as fees_egp,
  coalesce(sum(sl.net_egp), 0) as net_egp,
  -- What the courier says they collected, against what the goods and the
  -- shipping were worth. Anything other than zero means a parcel was collected
  -- for the wrong amount, which is worth seeing rather than averaging away.
  coalesce(sum(sl.collected_egp), 0)
    - coalesce(sum(o.total_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    - coalesce(sum(sl.customer_shipping_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    as collection_difference_egp,
  coalesce(sum(sl.customer_shipping_egp) filter (where sl.outcome = 'delivered' and sl.collected_egp > 0), 0)
    as customer_shipping_egp
from public.settlement_lines sl
left join public.orders o on o.id = sl.order_id
group by sl.settlement_id;
