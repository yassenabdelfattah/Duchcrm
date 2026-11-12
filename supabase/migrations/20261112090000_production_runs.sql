-- The manufacturing log: one entry for the products made together (2026-11-12).
--
-- The owner's ask, the day after profit went in: black cuffed sweatpants and
-- ash grey cuffed sweatpants are cut from one order of fabric by one tailor
-- and cost the same, and typing that cost into each product by hand is the
-- same figures twice. And once typed, nothing said what the last run had
-- cost, or kept the receipts that prove it.
--
-- A production run is one entry: the date, the products made in it and how
-- many of each, and the cost lines. A line is either what was paid in total
-- (the fabric invoice - shared over every piece of the run) or an amount per
-- piece. Receipts are photos attached to the entry. The log is the list of
-- runs; a run is compared with the one before it for the same product.
--
-- Saving a run changes no product's cost (the owner's choice: ask each
-- time). apply_production_run() does that, for the products ticked, from a
-- date: the run's lines become the product's cost lines, and the amounts the
-- product sets aside - against courier losses, for the gift fund - are kept
-- as they were, since they are not part of making it.
--
-- Nothing here touches a selling price. Prices are Shopify's.
-- Nothing here touches stock. Pieces are received on the stock page.

create table public.production_runs (
  id         uuid primary key default gen_random_uuid(),
  made_on    date not null,
  name       text not null check (length(btrim(name)) between 1 and 80),
  note       text,
  created_by uuid references public.staff (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index production_runs_made_on_idx on public.production_runs (made_on desc);

create trigger production_runs_touch_updated_at
  before update on public.production_runs
  for each row execute function public.touch_updated_at();

comment on table public.production_runs is
  'One manufacturing run: the products made together and what making them cost. '
  'Written through save_production_run(); costs are applied by apply_production_run().';

create table public.production_run_products (
  run_id     uuid not null references public.production_runs (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  -- How many were made. Needed to share a total bill out; not stock.
  pieces     integer not null default 0 check (pieces >= 0),
  -- The cost sheet this run was applied to the product as, once it was.
  applied_sheet_id uuid references public.cost_sheets (id) on delete set null,
  primary key (run_id, product_id)
);

create index production_run_products_product_idx on public.production_run_products (product_id);

-- total      what was paid for the whole run: shared over every piece of it
-- per_piece  an amount for each piece
create table public.production_run_lines (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.production_runs (id) on delete cascade,
  label      text not null check (length(btrim(label)) between 1 and 60),
  basis      text not null default 'per_piece' check (basis in ('total', 'per_piece')),
  amount_egp numeric(12, 2) not null check (amount_egp >= 0),
  position   integer not null default 0
);

create index production_run_lines_run_idx on public.production_run_lines (run_id, position);

-- A photo of a receipt, kept in the private "receipts" bucket under the run's id.
create table public.production_run_receipts (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.production_runs (id) on delete cascade,
  path       text not null unique,
  file_name  text,
  created_by uuid references public.staff (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index production_run_receipts_run_idx on public.production_run_receipts (run_id);

-- --- Who may read and write ----------------------------------------------------------------

alter table public.production_runs         enable row level security;
alter table public.production_run_products enable row level security;
alter table public.production_run_lines    enable row level security;
alter table public.production_run_receipts enable row level security;

-- What things cost to make is the margin: profit.view, as for every cost.
create policy production_runs_select on public.production_runs
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy production_runs_delete on public.production_runs
  for delete to authenticated using ((select public.has_permission('profit.view')));
create policy production_run_products_select on public.production_run_products
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy production_run_lines_select on public.production_run_lines
  for select to authenticated using ((select public.has_permission('profit.view')));
create policy production_run_receipts_all on public.production_run_receipts
  for all to authenticated
  using ((select public.has_permission('profit.view')))
  with check ((select public.has_permission('profit.view')));

grant select, delete on public.production_runs to authenticated;
grant select on public.production_run_products, public.production_run_lines to authenticated;
grant select, insert, delete on public.production_run_receipts to authenticated;

-- The photos themselves. Private: read through signed links the dashboard
-- asks for, and only by whoever may see costs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;

create policy receipts_read on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and (select public.has_permission('profit.view')));
create policy receipts_add on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and (select public.has_permission('profit.view')));
create policy receipts_remove on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and (select public.has_permission('profit.view')));

-- --- Saving a run ----------------------------------------------------------------------------

-- The whole entry at once. Given the id of a run that exists, it is put
-- right: its products and lines are replaced, its receipts kept, and what it
-- was already applied as stays applied.
--
-- p_products: [{ "product_id": "...", "pieces": 80 }]
-- p_lines:    [{ "label": "قماش", "basis": "total", "amount_egp": 45000 }]
create or replace function public.save_production_run(
  p_id       uuid,
  p_made_on  date,
  p_name     text,
  p_note     text,
  p_products jsonb,
  p_lines    jsonb
)
returns public.production_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run      public.production_runs;
  v_item     jsonb;
  v_position integer := 0;
  v_pieces   integer;
begin
  if not public.has_permission('profit.view') then
    raise exception 'You may not change costs' using errcode = 'insufficient_privilege';
  end if;

  if p_made_on is null then
    raise exception 'Say when it was made' using errcode = 'invalid_parameter_value';
  end if;
  if nullif(btrim(p_name), '') is null then
    raise exception 'Give the run a name' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) = 0 then
    raise exception 'Choose at least one product for the run' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A cost needs at least one line' using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(sum(greatest(coalesce((i ->> 'pieces')::integer, 0), 0)), 0)::integer
    into v_pieces
    from jsonb_array_elements(p_products) i;

  -- A total bill is shared over the pieces made, so it needs their number.
  if v_pieces = 0 and exists (
    select 1 from jsonb_array_elements(p_lines) l where coalesce(l ->> 'basis', 'per_piece') = 'total'
  ) then
    raise exception 'Say how many pieces were made, to share the total bills over them'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.production_runs (id, made_on, name, note, created_by)
  values (coalesce(p_id, gen_random_uuid()), p_made_on, btrim(p_name), nullif(btrim(p_note), ''), auth.uid())
  on conflict (id) do update
    set made_on = excluded.made_on, name = excluded.name, note = excluded.note, updated_at = now()
  returning * into v_run;

  -- Products no longer in the run leave it; the rest keep what they were applied as.
  delete from public.production_run_products
   where run_id = v_run.id
     and product_id not in (select (i ->> 'product_id')::uuid from jsonb_array_elements(p_products) i);

  for v_item in select * from jsonb_array_elements(p_products)
  loop
    if not exists (select 1 from public.products where id = (v_item ->> 'product_id')::uuid) then
      raise exception 'Unknown product %', v_item ->> 'product_id' using errcode = 'no_data_found';
    end if;
    insert into public.production_run_products (run_id, product_id, pieces)
    values (v_run.id, (v_item ->> 'product_id')::uuid, greatest(coalesce((v_item ->> 'pieces')::integer, 0), 0))
    on conflict (run_id, product_id) do update set pieces = excluded.pieces;
  end loop;

  delete from public.production_run_lines where run_id = v_run.id;
  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    if nullif(btrim(v_item ->> 'label'), '') is null then
      raise exception 'Every cost line needs a name' using errcode = 'invalid_parameter_value';
    end if;
    if (v_item ->> 'amount_egp') is null or (v_item ->> 'amount_egp')::numeric < 0 then
      raise exception 'The amount for % must be zero or more', v_item ->> 'label'
        using errcode = 'invalid_parameter_value';
    end if;
    insert into public.production_run_lines (run_id, label, basis, amount_egp, position)
    values (v_run.id, btrim(v_item ->> 'label'), coalesce(v_item ->> 'basis', 'per_piece'),
            (v_item ->> 'amount_egp')::numeric, v_position);
    v_position := v_position + 1;
  end loop;

  return v_run;
end;
$$;

revoke execute on function public.save_production_run(uuid, date, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.save_production_run(uuid, date, text, text, jsonb, jsonb) to authenticated, service_role;

-- --- What a run comes to per piece -------------------------------------------------------------

-- Each line of a run as an amount per piece: its own amount, or its total
-- shared over every piece the run made. The dashboard works out the same
-- (lib/productionMath.ts); this is what apply_production_run() writes.
create or replace view public.v_production_run_lines
with (security_invoker = on) as
select
  l.id as line_id,
  l.run_id,
  l.label,
  l.basis,
  l.amount_egp,
  l.position,
  t.pieces as run_pieces,
  case
    when l.basis = 'per_piece' then l.amount_egp
    when t.pieces > 0 then round(l.amount_egp / t.pieces, 2)
  end as per_piece_egp
from public.production_run_lines l
cross join lateral (
  select coalesce(sum(p.pieces), 0)::integer as pieces
    from public.production_run_products p
   where p.run_id = l.run_id
) t;

grant select on public.v_production_run_lines to authenticated;

-- --- Making a run the products' cost -------------------------------------------------------------

-- Only ever called after the owner has seen old against new and said yes.
-- For each product named: a cost sheet from the date given, whose cost lines
-- are the run's and whose set-aside lines (courier losses, gift fund) are the
-- product's own, carried over from the cost in force that day. A sheet
-- already there for that date is replaced. Sales ordered before the date
-- keep the cost they had.
create or replace function public.apply_production_run(
  p_run_id         uuid,
  p_product_ids    uuid[],
  p_effective_from date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product uuid;
  v_lines   jsonb;
  v_kept    jsonb;
  v_sheet   public.cost_sheets;
  v_count   integer := 0;
begin
  if not public.has_permission('profit.view') then
    raise exception 'You may not change costs' using errcode = 'insufficient_privilege';
  end if;
  if p_effective_from is null then
    raise exception 'Say which date the cost counts from' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.production_runs where id = p_run_id) then
    raise exception 'Unknown production run %', p_run_id using errcode = 'no_data_found';
  end if;

  select jsonb_agg(jsonb_build_object('kind', 'cost', 'label', label, 'amount_egp', per_piece_egp) order by position)
    into v_lines
    from public.v_production_run_lines
   where run_id = p_run_id;

  if v_lines is null or exists (
    select 1 from public.v_production_run_lines where run_id = p_run_id and per_piece_egp is null
  ) then
    raise exception 'Say how many pieces were made, to share the total bills over them'
      using errcode = 'invalid_parameter_value';
  end if;

  foreach v_product in array coalesce(p_product_ids, '{}')
  loop
    if not exists (
      select 1 from public.production_run_products where run_id = p_run_id and product_id = v_product
    ) then
      raise exception 'That product is not part of this production run' using errcode = 'invalid_parameter_value';
    end if;

    -- What the product sets aside, from its cost in force on that date (or
    -- its first cost, if that is later): not part of making it, so kept.
    select coalesce(jsonb_agg(jsonb_build_object(
             'kind', cl.kind, 'label', cl.label, 'amount_egp', cl.amount_egp,
             'overrides', coalesce((
               select jsonb_agg(jsonb_build_object('size', o.size, 'color', o.color, 'amount_egp', o.amount_egp))
                 from public.cost_line_overrides o where o.line_id = cl.id), '[]'::jsonb)
           ) order by cl.position), '[]'::jsonb)
      into v_kept
      from public.cost_lines cl
     where cl.kind <> 'cost'
       and cl.sheet_id = (
         select s.id from public.cost_sheets s
          where s.product_id = v_product
          order by (s.effective_from <= p_effective_from) desc,
                   case when s.effective_from <= p_effective_from then s.effective_from end desc,
                   s.effective_from asc
          limit 1);

    v_sheet := public.save_cost_sheet(
      v_product, p_effective_from, v_lines || v_kept,
      (select name from public.production_runs where id = p_run_id));

    update public.production_run_products
       set applied_sheet_id = v_sheet.id
     where run_id = p_run_id and product_id = v_product;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.apply_production_run(uuid, uuid[], date) from public, anon;
grant execute on function public.apply_production_run(uuid, uuid[], date) to authenticated, service_role;
