-- Profit: what each piece costs to make, what was spent, and who may see it
-- (2026-11-11).
--
-- The owner's ask: a profit number that can be believed. Until now the CRM
-- knew what was sold and one bare cost per variant for valuing stock. It did
-- not know what a piece costs to make line by line, what the ads cost, the
-- rent, or what the courier really cost - so no screen could say "profit".
--
-- What the owner decided, in order:
--   * A product has one cost, with a history. A new cost counts from a date;
--     sales ordered before it keep the old one.
--   * The cost is lines the owner names - fabric, tailoring, accessories,
--     printing, packaging, anything else - and a line can differ for a size
--     or a colour.
--   * Two amounts per piece are set aside rather than spent: one against
--     what the courier costs us (refusals, free shipping, fee gaps), whose
--     leftover is profit; and one for the gift fund, kept apart from profit
--     and spent on offers and giveaways.
--   * Ads are typed in as a total for some days and shared out by pieces sold.
--   * Fixed costs (rent, salaries, anything typed in) come off the month they
--     were paid in.
--   * Only people with the new permission profit.view see any of it.
--
-- The sums are done in the dashboard (lib/profitMath.ts, tested there), from
-- these tables and the report views that already exist. This file holds the
-- facts and guards them.

-- --- The permission ----------------------------------------------------------------------

create or replace function public.known_permissions()
returns text[]
language sql
immutable
as $$
  select array[
    'sales.create',        -- بيع جديد: the sale page, and orders taken by message
    'orders.read',         -- رؤية الطلبات
    'orders.settle',       -- تسجيل التحصيل
    'orders.edit',         -- تعديل الطلبات
    'orders.cancel',       -- إلغاء الطلبات
    'orders.ship',         -- الشحن والتجهيز
    'returns.manage',      -- المرتجعات
    'stock.read',          -- رؤية المخزون
    'stock.adjust',        -- تعديل وإخراج المخزون
    'products.manage',     -- المنتجات والأسعار
    'reports.read',        -- التقارير
    'settlements.manage',  -- التسويات
    'sync.manage',         -- مشاكل المزامنة
    'staff.manage',        -- الموظفون والأدوار
    'profit.view'          -- الأرباح والتكاليف
  ]::text[];
$$;

-- --- What a piece costs --------------------------------------------------------------------

-- One sheet per product per date it counts from. A sale is costed by the
-- sheet in force on the day it was ordered; a sale from before the first
-- sheet is costed by the first, so typing a cost in covers the past too.
create table public.cost_sheets (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references public.products (id) on delete cascade,
  effective_from date not null,
  note           text,
  created_by     uuid references public.staff (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (product_id, effective_from)
);

comment on table public.cost_sheets is
  'What one piece of a product costs, from a date. Written only through save_cost_sheet().';

create trigger cost_sheets_touch_updated_at
  before update on public.cost_sheets
  for each row execute function public.touch_updated_at();

-- cost          spent making the piece: fabric, tailoring, packaging...
-- loss_reserve  set aside per piece against what the courier costs us
-- gift_reserve  set aside per piece for the gift fund
create table public.cost_lines (
  id         uuid primary key default gen_random_uuid(),
  sheet_id   uuid not null references public.cost_sheets (id) on delete cascade,
  kind       text not null default 'cost' check (kind in ('cost', 'loss_reserve', 'gift_reserve')),
  label      text not null check (length(btrim(label)) between 1 and 60),
  amount_egp numeric(12, 2) not null check (amount_egp >= 0),
  position   integer not null default 0
);

create index cost_lines_sheet_idx on public.cost_lines (sheet_id, position);

-- A line that costs something else for a size, a colour, or one colour in
-- one size. Kept by size and colour rather than by variant, so a size added
-- to the product later is already covered.
create table public.cost_line_overrides (
  id         uuid primary key default gen_random_uuid(),
  line_id    uuid not null references public.cost_lines (id) on delete cascade,
  size       text,
  color      text,
  amount_egp numeric(12, 2) not null check (amount_egp >= 0),
  check (size is not null or color is not null)
);

create index cost_line_overrides_line_idx on public.cost_line_overrides (line_id);

-- --- What was spent ------------------------------------------------------------------------

-- A total typed in for some days, spread evenly over them.
create table public.ad_spend (
  id         uuid primary key default gen_random_uuid(),
  platform   text not null default 'meta' check (length(btrim(platform)) between 1 and 30),
  from_date  date not null,
  to_date    date not null,
  amount_egp numeric(12, 2) not null check (amount_egp > 0),
  note       text,
  created_by uuid references public.staff (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);

create index ad_spend_dates_idx on public.ad_spend (from_date, to_date);

-- expense  comes off profit in the month it was paid: rent, salaries, a shoot
-- gift     comes out of the gift fund, never off profit
create table public.expenses (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'expense' check (kind in ('expense', 'gift')),
  spent_on   date not null,
  category   text not null check (length(btrim(category)) between 1 and 60),
  amount_egp numeric(12, 2) not null check (amount_egp >= 0),
  note       text,
  -- Set when the gift fund bought pieces off our own shelf: the stock-out
  -- that took them.
  stock_out_id uuid references public.stock_outs (id) on delete set null,
  created_by uuid references public.staff (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index expenses_spent_on_idx on public.expenses (spent_on);

-- The pieces the gift fund bought from our own stock, at the price typed in.
-- They count as sold at that price, against what they cost to make.
create table public.expense_items (
  id             uuid primary key default gen_random_uuid(),
  expense_id     uuid not null references public.expenses (id) on delete cascade,
  variant_id     uuid not null references public.variants (id) on delete restrict,
  quantity       integer not null check (quantity > 0),
  unit_price_egp numeric(12, 2) not null check (unit_price_egp >= 0)
);

create index expense_items_expense_idx on public.expense_items (expense_id);

-- One row: when the gift fund starts counting and with how much, and which
-- parts the monthly report shows.
create table public.profit_settings (
  id                    boolean primary key default true check (id),
  gift_fund_from        date not null default (now() at time zone 'Africa/Cairo')::date,
  gift_fund_opening_egp numeric(12, 2) not null default 0,
  -- The parts of the monthly report switched off. Empty shows everything, so
  -- a part added later shows until someone hides it.
  report_hidden         text[] not null default '{}',
  updated_at            timestamptz not null default now()
);

insert into public.profit_settings (id) values (true);

create trigger profit_settings_touch_updated_at
  before update on public.profit_settings
  for each row execute function public.touch_updated_at();

-- --- Who may read and write ----------------------------------------------------------------

alter table public.cost_sheets         enable row level security;
alter table public.cost_lines          enable row level security;
alter table public.cost_line_overrides enable row level security;
alter table public.ad_spend            enable row level security;
alter table public.expenses            enable row level security;
alter table public.expense_items       enable row level security;
alter table public.profit_settings     enable row level security;

-- Cost is the margin: nobody without profit.view reads a row of any of it.
create policy cost_sheets_select on public.cost_sheets
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy cost_lines_select on public.cost_lines
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy cost_line_overrides_select on public.cost_line_overrides
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy expense_items_select on public.expense_items
  for select to authenticated using ((select public.has_permission('profit.view')));

create policy ad_spend_all on public.ad_spend
  for all to authenticated
  using ((select public.has_permission('profit.view')))
  with check ((select public.has_permission('profit.view')));

create policy expenses_all on public.expenses
  for all to authenticated
  using ((select public.has_permission('profit.view')))
  with check ((select public.has_permission('profit.view')));

create policy profit_settings_select on public.profit_settings
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy profit_settings_update on public.profit_settings
  for update to authenticated
  using ((select public.has_permission('profit.view')))
  with check ((select public.has_permission('profit.view')));

grant select on public.cost_sheets, public.cost_lines, public.cost_line_overrides, public.expense_items to authenticated;
grant select, insert, update, delete on public.ad_spend, public.expenses to authenticated;
grant select, update on public.profit_settings to authenticated;

-- What the courier cost is read off its statements, which until now only
-- settlements.manage could read.
create policy courier_settlements_select_profit on public.courier_settlements
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy settlement_lines_select_profit on public.settlement_lines
  for select to authenticated using ((select public.has_permission('profit.view')));

-- --- Saving a cost -------------------------------------------------------------------------

-- The whole sheet at once: its lines, and each line's sizes and colours that
-- differ. Saved again for the same date it replaces that sheet (a typo put
-- right); saved for a new date it is a new cost from then on, and the sales
-- before it keep the old one.
--
-- p_lines: [{ "kind": "cost", "label": "قماش", "amount_egp": 120,
--             "overrides": [{ "size": "XL", "color": null, "amount_egp": 140 }] }]
create or replace function public.save_cost_sheet(
  p_product_id     uuid,
  p_effective_from date,
  p_lines          jsonb,
  p_note           text default null
)
returns public.cost_sheets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sheet    public.cost_sheets;
  v_line     jsonb;
  v_override jsonb;
  v_line_id  uuid;
  v_position integer := 0;
  v_kind     text;
begin
  if not public.has_permission('profit.view') then
    raise exception 'You may not change costs' using errcode = 'insufficient_privilege';
  end if;

  if p_effective_from is null then
    raise exception 'Say which date the cost counts from' using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Unknown product %', p_product_id using errcode = 'no_data_found';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A cost needs at least one line' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.cost_sheets (product_id, effective_from, note, created_by)
  values (p_product_id, p_effective_from, nullif(btrim(p_note), ''), auth.uid())
  on conflict (product_id, effective_from)
  do update set note = excluded.note, updated_at = now()
  returning * into v_sheet;

  delete from public.cost_lines where sheet_id = v_sheet.id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_kind := coalesce(v_line ->> 'kind', 'cost');
    if nullif(btrim(v_line ->> 'label'), '') is null then
      raise exception 'Every cost line needs a name' using errcode = 'invalid_parameter_value';
    end if;
    if (v_line ->> 'amount_egp') is null or (v_line ->> 'amount_egp')::numeric < 0 then
      raise exception 'The amount for % must be zero or more', v_line ->> 'label'
        using errcode = 'invalid_parameter_value';
    end if;

    insert into public.cost_lines (sheet_id, kind, label, amount_egp, position)
    values (v_sheet.id, v_kind, btrim(v_line ->> 'label'), (v_line ->> 'amount_egp')::numeric, v_position)
    returning id into v_line_id;
    v_position := v_position + 1;

    if jsonb_typeof(v_line -> 'overrides') = 'array' then
      for v_override in select * from jsonb_array_elements(v_line -> 'overrides')
      loop
        if (v_override ->> 'amount_egp') is null or (v_override ->> 'amount_egp')::numeric < 0 then
          raise exception 'The amount for % must be zero or more', v_line ->> 'label'
            using errcode = 'invalid_parameter_value';
        end if;
        insert into public.cost_line_overrides (line_id, size, color, amount_egp)
        values (
          v_line_id,
          nullif(btrim(v_override ->> 'size'), ''),
          nullif(btrim(v_override ->> 'color'), ''),
          (v_override ->> 'amount_egp')::numeric
        );
      end loop;
    end if;
  end loop;

  return v_sheet;
end;
$$;

create or replace function public.delete_cost_sheet(p_sheet_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_permission('profit.view') then
    raise exception 'You may not change costs' using errcode = 'insufficient_privilege';
  end if;
  delete from public.cost_sheets where id = p_sheet_id;
end;
$$;

revoke execute on function public.save_cost_sheet(uuid, date, jsonb, text) from public, anon;
grant execute on function public.save_cost_sheet(uuid, date, jsonb, text) to authenticated, service_role;
revoke execute on function public.delete_cost_sheet(uuid) from public, anon;
grant execute on function public.delete_cost_sheet(uuid) to authenticated, service_role;

-- --- The gift fund buys from our own shelf -----------------------------------------------------

-- Dead stock given away: the fund pays the price typed in for each piece, the
-- pieces leave the shelf as a gift (a stock-out, so the ledger says where
-- they went), and they count as sold at that price.
--
-- p_items: [{ "variant_id": "...", "quantity": 2, "unit_price_egp": 300 }]
create or replace function public.record_gift_from_stock(
  p_spent_on        date,
  p_note            text,
  p_items           jsonb,
  p_idempotency_key text
)
returns public.expenses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expense public.expenses;
  v_out     public.stock_outs;
  v_item    jsonb;
  v_total   numeric(12, 2) := 0;
begin
  if not public.has_permission('profit.view') then
    raise exception 'You may not spend from the gift fund' using errcode = 'insufficient_privilege';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to take out' using errcode = 'invalid_parameter_value';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item ->> 'unit_price_egp') is null or (v_item ->> 'unit_price_egp')::numeric < 0 then
      raise exception 'Every piece needs a price' using errcode = 'invalid_parameter_value';
    end if;
    v_total := v_total + (v_item ->> 'unit_price_egp')::numeric * (v_item ->> 'quantity')::integer;
  end loop;

  -- Takes the pieces off the shelf, refusing what is not there; a second tap
  -- gets the first stock-out back, and the expense that went with it.
  v_out := public.record_stock_out(
    p_location_id     => null,
    p_reason          => 'gift',
    p_reason_text     => null,
    p_items           => p_items,
    p_taken_by        => null,
    p_note            => p_note,
    p_expects_return  => false,
    p_return_by       => null,
    p_idempotency_key => p_idempotency_key
  );

  select * into v_expense from public.expenses where stock_out_id = v_out.id;
  if found then
    return v_expense;
  end if;

  insert into public.expenses (kind, spent_on, category, amount_egp, note, stock_out_id, created_by)
  values ('gift', coalesce(p_spent_on, (now() at time zone 'Africa/Cairo')::date),
          'مخزون راكد', v_total, nullif(btrim(p_note), ''), v_out.id, auth.uid())
  returning * into v_expense;

  insert into public.expense_items (expense_id, variant_id, quantity, unit_price_egp)
  select v_expense.id, (i ->> 'variant_id')::uuid, (i ->> 'quantity')::integer, (i ->> 'unit_price_egp')::numeric
    from jsonb_array_elements(p_items) i;

  return v_expense;
end;
$$;

revoke execute on function public.record_gift_from_stock(date, text, jsonb, text) from public, anon;
grant execute on function public.record_gift_from_stock(date, text, jsonb, text) to authenticated, service_role;

-- --- What the courier cost us ----------------------------------------------------------------

-- One row per thing a parcel cost us on a courier statement, on the Cairo day
-- its order was placed (a line with no order: the statement's day), so a
-- month's courier cost sits with that month's sales.
--
-- On a delivery the customer pays the shipping and the courier keeps it: no
-- cost of ours. What is ours:
--   refused        nothing collected, the courier's fee charged (a customer
--                  who paid the shipping and refused the goods nets to zero)
--   no_response    the small fee after three tries
--   returned_other any other parcel that came back
--   free_shipping  delivered, the customer charged no shipping, the fee ours
--   fee_gap        delivered, the courier charged more or less than the
--                  customer was charged for shipping
--   collection_gap delivered, the courier collected more or less than the
--                  goods and the shipping came to
--   adjustment     a correction on the statement with no parcel
-- A gain is a negative cost. Lines from before 2026-10-27 carry no customer
-- shipping: their collected amount is the goods alone and their fee is what
-- was charged to us.
create or replace view public.v_profit_courier
with (security_invoker = on) as
with line as (
  select
    sl.id as line_id,
    sl.settlement_id,
    s.reference,
    s.status::text as statement_status,
    coalesce(s.received_at, s.statement_date, (s.created_at at time zone 'Africa/Cairo')::date) as statement_on,
    sl.order_id,
    o.order_number,
    coalesce(
      (o.created_at at time zone 'Africa/Cairo')::date,
      s.received_at, s.statement_date, (s.created_at at time zone 'Africa/Cairo')::date
    ) as counted_on,
    sl.outcome::text as outcome,
    sl.tracking_number,
    sl.collected_egp,
    sl.fee_egp,
    sl.customer_shipping_egp,
    sl.note,
    -- The shipping the customer paid: at the door, or online with the order.
    case
      when sl.customer_shipping_egp is null then null
      when sh.cod_amount_egp = 0 then coalesce(o.shipping_egp, 0)
      else sl.customer_shipping_egp
    end as shipping_paid_egp,
    -- The goods the courier was to collect for, less what was refused at the door.
    o.total_egp
      - case when o.fulfillment_status = 'delivered' then public.order_returned_off_egp(o.id) else 0 end
      as goods_egp
  from public.settlement_lines sl
  join public.courier_settlements s on s.id = sl.settlement_id
  left join public.orders o on o.id = sl.order_id
  left join public.shipments sh on sh.id = sl.shipment_id
)
select line_id, settlement_id, reference, statement_status, statement_on, order_id, order_number,
       counted_on, tracking_number, note,
       case
         when outcome = 'returned_refused' then 'refused'
         when outcome = 'returned_no_response' then 'no_response'
         when outcome = 'returned_other' then 'returned_other'
         when outcome = 'adjustment' then 'adjustment'
         when coalesce(shipping_paid_egp, 0) = 0 then 'free_shipping'
         else 'fee_gap'
       end as kind,
       (case
          when outcome = 'delivered' then fee_egp - coalesce(shipping_paid_egp, 0)
          else fee_egp - collected_egp
        end)::numeric(12, 2) as cost_egp
  from line
 where case
         when outcome = 'delivered' then fee_egp - coalesce(shipping_paid_egp, 0)
         else fee_egp - collected_egp
       end <> 0

union all

select line_id, settlement_id, reference, statement_status, statement_on, order_id, order_number,
       counted_on, tracking_number, note,
       'collection_gap',
       (goods_egp + customer_shipping_egp - collected_egp)::numeric(12, 2)
  from line
 where outcome = 'delivered'
   and collected_egp > 0
   and customer_shipping_egp is not null
   and goods_egp is not null
   and goods_egp + customer_shipping_egp - collected_egp <> 0;

comment on view public.v_profit_courier is
  'What each parcel cost us on a courier statement (negative: a gain), on the Cairo '
  'day its order was placed. Drafts are included, marked by statement_status.';

grant select on public.v_profit_courier to authenticated;
