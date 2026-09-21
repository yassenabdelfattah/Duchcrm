-- ---------------------------------------------------------------------------
-- Settlements count goods, not shipping. And they can carry deductions.
--
-- Accurate keeps the shipping fee the customer pays at the door. On a 1,850
-- hoodie with 70 shipping the customer hands over 1,920, Accurate keeps the
-- 70, and 1,850 reaches the bank. The 70 was never Duch's money.
--
-- A settlement line expected `shipments.cod_amount_egp`, which is the whole
-- 1,920. Every delivered line therefore expected the shipping fee back as
-- well, so a statement that was in fact perfectly correct showed a shortfall
-- of 70 per parcel - and review_settlement refuses to close on a difference,
-- which means a correct statement could not be closed at all.
--
-- The accountant's product rollup was always right: v_settlement_products
-- sums order line items and has never included shipping.
-- ---------------------------------------------------------------------------

create or replace function public.add_settlement_line(
  p_settlement_id  uuid,
  p_tracking_number text,
  p_outcome        public.settlement_outcome,
  p_collected_egp  numeric DEFAULT NULL,
  p_fee_egp        numeric DEFAULT 0,
  p_note           text DEFAULT NULL
)
returns public.settlement_lines
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- The goods, after discount. NOT cod_amount_egp, which is what the customer
  -- handed over including the shipping Accurate keeps.
  v_expected := v_order.total_egp;

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
$function$;

revoke execute on function public.add_settlement_line(
  uuid, text, public.settlement_outcome, numeric, numeric, text
) from public, anon;
grant execute on function public.add_settlement_line(
  uuid, text, public.settlement_outcome, numeric, numeric, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deductions and extras that belong to no parcel.
--
-- The courier's statement is not only a list of parcels. It carries charges
-- against the whole month - packaging, a fee for returned parcels, a
-- correction for something they got wrong last time. Without somewhere to put
-- them the statement cannot be made to balance, and review_settlement refuses
-- to close anything that does not.
--
-- `collected_egp` and `fee_egp` are both constrained to be non-negative, and
-- deliberately so: a settlement where money can be entered as a negative
-- collection is one where a mistake hides. So the sign decides the column -
-- money owed to Duch is collected, money taken off is a fee - and the
-- generated `net_egp` comes out with the right sign either way.
-- ---------------------------------------------------------------------------

create or replace function public.add_settlement_adjustment(
  p_settlement_id uuid,
  p_label         text,
  p_amount_egp    numeric
)
returns public.settlement_lines
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_line   public.settlement_lines;
  v_amount numeric(12, 2) := round(coalesce(p_amount_egp, 0), 2);
  v_label  text := nullif(trim(coalesce(p_label, '')), '');
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

  -- An unlabelled deduction is the thing nobody can explain in three months.
  if v_label is null then
    raise exception 'An adjustment needs a description'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_amount = 0 then
    raise exception 'An adjustment of zero changes nothing'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.settlement_lines (
    settlement_id, order_id, shipment_id, tracking_number,
    outcome, collected_egp, fee_egp, expected_egp, note
  )
  values (
    p_settlement_id, null, null, null,
    'adjustment',
    case when v_amount > 0 then v_amount else 0 end,
    case when v_amount < 0 then -v_amount else 0 end,
    null,
    v_label
  )
  returning * into v_line;

  return v_line;
end;
$$;

comment on function public.add_settlement_adjustment(uuid, text, numeric) is
  'A named charge or credit on a statement that belongs to no single parcel. Negative takes money off.';

revoke execute on function public.add_settlement_adjustment(uuid, text, numeric) from public, anon;
grant execute on function public.add_settlement_adjustment(uuid, text, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- An adjustment is not an unmatched parcel.
--
-- Both have no order against them, and "unmatched" is a warning meaning a
-- tracking code on the statement matched nothing in the CRM - something to
-- chase. An adjustment has no order on purpose, and counting it as unmatched
-- turns a real warning into noise.
-- ---------------------------------------------------------------------------

-- The existing columns keep their order and names: CREATE OR REPLACE VIEW can
-- only append, and adjustment_count therefore goes last however much it would
-- rather sit next to the other counts.
create or replace view public.v_settlement_totals as
select
  s.id as settlement_id,
  s.reference,
  s.received_at,
  s.status,
  s.net_received_egp,
  count(sl.id) as line_count,
  count(*) filter (where sl.outcome = 'delivered') as delivered_count,
  count(*) filter (where sl.outcome not in ('delivered', 'adjustment')) as return_count,
  coalesce(sum(sl.collected_egp), 0) as collected_egp,
  coalesce(sum(sl.fee_egp), 0) as fees_egp,
  coalesce(sum(sl.net_egp), 0) as net_egp,
  coalesce(s.net_received_egp, coalesce(sum(sl.net_egp), 0)) - coalesce(sum(sl.net_egp), 0)
    as difference_egp,
  count(*) filter (where sl.order_id is null and sl.outcome <> 'adjustment') as unmatched_lines,
  count(*) filter (where sl.outcome = 'adjustment') as adjustment_count
from public.courier_settlements s
left join public.settlement_lines sl on sl.settlement_id = s.id
group by s.id;

create or replace function public.review_settlement(p_settlement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_settlement public.courier_settlements;
  v_lines_net  numeric(12, 2);
  v_paid       integer := 0;
  v_unmatched  integer;
  v_difference numeric(12, 2);
begin
  if not (public.is_admin() or public.has_any_role('stock_manager') or public.is_service_request()) then
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
  -- money" honestly separate.
  update public.orders o
     set payment_status = 'paid'
    from public.settlement_lines sl
   where sl.settlement_id = p_settlement_id
     and sl.order_id = o.id
     and sl.outcome = 'delivered'
     and o.payment_status = 'pending';

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

revoke execute on function public.review_settlement(uuid) from public, anon;
grant execute on function public.review_settlement(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The accountant's breakdown loses its shipping column.
--
-- He records products and prices. Shipping is the courier's money, collected
-- at the door and kept, and it never reaches the transfer he is reconciling -
-- so a shipping line in his breakdown is a number he has to be told to
-- ignore. The identity becomes goods less courier charges equals the
-- transfer.
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW cannot
-- remove a column.
-- ---------------------------------------------------------------------------

drop view if exists public.v_settlement_breakdown;

create view public.v_settlement_breakdown as
select
  sl.settlement_id,
  coalesce(sum(o.total_egp) filter (where sl.outcome = 'delivered'), 0) as goods_egp,
  coalesce(sum(sl.collected_egp), 0) as collected_egp,
  coalesce(sum(sl.fee_egp), 0) as fees_egp,
  coalesce(sum(sl.net_egp), 0) as net_egp,
  -- What the courier says they collected, against what the goods were worth.
  -- Anything other than zero means a parcel was collected for the wrong
  -- amount, which is worth seeing rather than averaging away.
  coalesce(sum(sl.collected_egp), 0)
    - coalesce(sum(o.total_egp) filter (where sl.outcome = 'delivered'), 0)
    as collection_difference_egp
from public.settlement_lines sl
left join public.orders o on o.id = sl.order_id
group by sl.settlement_id;
