-- ---------------------------------------------------------------------------
-- Phase 3: courier settlements.
--
-- Accurate's statement cannot be exported from their app and is not available
-- over an API, so it is entered by hand: their statement open on one side, the
-- CRM on the other. The job of this schema is to make that entry as short as
-- possible and then do the checking automatically.
--
-- Entry is keyed on the courier's own tracking code, which resolves straight
-- to a shipment and therefore to an order. Because the CRM already knows what
-- that order was worth, the expected amount is pre-filled and the only real
-- input is the fee and any correction - so the work becomes confirming rather
-- than transcribing.
--
-- The customer pays shipping on top of the goods, and it is inside the amount
-- the courier collects. The courier then deducts their fee and remits the
-- rest, so for each line:
--
--     net to us = what they collected at the door - what they charged us
--
-- A refused delivery collects nothing and still costs a fee, so its net is
-- negative. That is the real, countable cost of a refusal.
-- ---------------------------------------------------------------------------

create type public.settlement_status as enum ('draft', 'reviewed', 'exported');

create type public.settlement_outcome as enum (
  'delivered',             -- collected in full
  'returned_refused',      -- refused at the door. Costs a full shipping fee.
  'returned_no_response',  -- never answered or scheduled. Small fee.
  'returned_other',
  'adjustment'             -- anything the courier corrected on the statement
);

create table public.courier_settlements (
  id                  uuid primary key default gen_random_uuid(),
  courier             text not null default 'accurate',
  -- Their statement or transfer reference, so a line on the bank statement can
  -- be traced back to this row a year from now.
  reference           text,
  statement_date      date,
  received_at         date,
  -- What actually landed in the bank. Typed from the transfer notification,
  -- and deliberately independent of the lines below so the two can be compared.
  net_received_egp    numeric(12, 2),
  status              public.settlement_status not null default 'draft',
  note                text,
  created_by          uuid references public.staff (id) on delete set null,
  reviewed_by         uuid references public.staff (id) on delete set null,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.courier_settlements is
  'One row per transfer from the courier. Entered by hand from their statement.';

create index courier_settlements_status_idx
  on public.courier_settlements (status, received_at desc);

create trigger courier_settlements_touch_updated_at
  before update on public.courier_settlements
  for each row execute function public.touch_updated_at();

create table public.settlement_lines (
  id              uuid primary key default gen_random_uuid(),
  settlement_id   uuid not null references public.courier_settlements (id) on delete cascade,
  order_id        uuid references public.orders (id) on delete set null,
  shipment_id     uuid references public.shipments (id) on delete set null,
  tracking_number text,
  outcome         public.settlement_outcome not null,
  -- What the courier collected from the customer. Zero on a return.
  collected_egp   numeric(12, 2) not null default 0 check (collected_egp >= 0),
  -- What the courier charged us. Always entered positive; it is subtracted.
  fee_egp         numeric(12, 2) not null default 0 check (fee_egp >= 0),
  net_egp         numeric(12, 2) generated always as (collected_egp - fee_egp) stored,
  -- What the CRM believed this order was worth, captured at entry time so a
  -- later price change cannot rewrite history.
  expected_egp    numeric(12, 2),
  note            text,
  created_at      timestamptz not null default now()
);

comment on column public.settlement_lines.net_egp is
  'Negative for a refusal: nothing collected, a fee charged. This column '
  'summed over a month is what refusals actually cost.';

create index settlement_lines_settlement_idx on public.settlement_lines (settlement_id);
create index settlement_lines_order_idx on public.settlement_lines (order_id);
create unique index settlement_lines_order_unique
  on public.settlement_lines (settlement_id, order_id)
  where order_id is not null;

-- --- Entering a line -------------------------------------------------------

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

  -- The tracking number is the courier's own code and the only thing that
  -- appears on both their statement and our records.
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

comment on function public.add_settlement_line is
  'Resolves the courier tracking code to a shipment and order, pre-fills the '
  'expected amount, and records what they actually paid and charged.';

-- --- Reviewing -------------------------------------------------------------

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

  select coalesce(sum(net_egp), 0), count(*) filter (where order_id is null)
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

  -- Delivered and paid for. This is the only place an order becomes paid,
  -- which is what keeps "delivered" and "we have the money" honestly separate.
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
    'net_total', v_lines_net
  );
end;
$$;

-- --- What the accountant gets ----------------------------------------------
--
-- Today this is a WhatsApp message typed out by hand, listing what each order
-- brought in and what the returns and fees took out. The same information,
-- assembled from the lines already entered.

create or replace view public.v_settlement_statement
with (security_invoker = on) as
select
  s.id                as settlement_id,
  s.reference,
  s.received_at,
  s.status,
  sl.id               as line_id,
  sl.tracking_number,
  sl.outcome,
  sl.collected_egp,
  sl.fee_egp,
  sl.net_egp,
  o.order_number,
  c.full_name         as customer_name,
  c.governorate,
  -- One readable line of what was in the parcel, which is the part the
  -- accountant actually reads.
  (
    select string_agg(li.title || ' (' || li.quantity || ')', ', ' order by li.created_at)
      from public.order_line_items li
     where li.order_id = o.id
  )                   as items
from public.courier_settlements s
join public.settlement_lines sl on sl.settlement_id = s.id
left join public.orders o on o.id = sl.order_id
left join public.customers c on c.id = o.customer_id;

comment on view public.v_settlement_statement is
  'Line by line detail behind one transfer, ready to print or paste into a '
  'message. Positive net is money in; negative is a return or a fee.';

create or replace view public.v_settlement_totals
with (security_invoker = on) as
select
  s.id                as settlement_id,
  s.reference,
  s.received_at,
  s.status,
  s.net_received_egp,
  count(sl.id)                                                        as line_count,
  count(*) filter (where sl.outcome = 'delivered')                    as delivered_count,
  count(*) filter (where sl.outcome <> 'delivered')                   as return_count,
  coalesce(sum(sl.collected_egp), 0)                                  as collected_egp,
  coalesce(sum(sl.fee_egp), 0)                                        as fees_egp,
  coalesce(sum(sl.net_egp), 0)                                        as net_egp,
  coalesce(s.net_received_egp, coalesce(sum(sl.net_egp), 0))
    - coalesce(sum(sl.net_egp), 0)                                    as difference_egp,
  count(*) filter (where sl.order_id is null)                         as unmatched_lines
from public.courier_settlements s
left join public.settlement_lines sl on sl.settlement_id = s.id
group by s.id;

-- --- Permissions -----------------------------------------------------------

alter table public.courier_settlements enable row level security;
alter table public.settlement_lines    enable row level security;

-- Settlements are money. Sales and packing staff have no business here.
create policy courier_settlements_select on public.courier_settlements
  for select to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')));

create policy courier_settlements_write on public.courier_settlements
  for all to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')))
  with check ((select public.has_any_role('admin', 'stock_manager')));

create policy settlement_lines_select on public.settlement_lines
  for select to authenticated
  using ((select public.has_any_role('admin', 'stock_manager')));

grant select, insert, update, delete on public.courier_settlements to authenticated;
grant select on public.settlement_lines to authenticated;
grant all on public.courier_settlements, public.settlement_lines to service_role;
grant select on public.v_settlement_statement, public.v_settlement_totals to authenticated;

revoke execute on function public.add_settlement_line(uuid, text, public.settlement_outcome, numeric, numeric, text) from public, anon;
grant execute on function public.add_settlement_line(uuid, text, public.settlement_outcome, numeric, numeric, text) to authenticated, service_role;

revoke execute on function public.review_settlement(uuid) from public, anon;
grant execute on function public.review_settlement(uuid) to authenticated, service_role;
