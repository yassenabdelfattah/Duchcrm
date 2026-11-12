-- Applying a manufacturing run can set what each piece puts aside (2026-11-12).
--
-- The owner, once the log was live: the amount set aside against courier
-- losses and the amount for the gift fund had to be typed product by product,
-- in another screen, straight after a whole run had been entered in one go.
--
-- They are still not part of what making a piece cost - the log's lines stay
-- the real bills, to match the receipts and to compare run with run. But the
-- step that makes a run the products' cost now takes the two amounts as
-- well: given, each product ticked gets that amount per piece; left out, each
-- keeps what it had, as before. Zero takes the line away.

drop function public.apply_production_run(uuid, uuid[], date);

create or replace function public.apply_production_run(
  p_run_id         uuid,
  p_product_ids    uuid[],
  p_effective_from date,
  p_loss_reserve   numeric default null,
  p_gift_reserve   numeric default null
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
  if p_loss_reserve < 0 or p_gift_reserve < 0 then
    raise exception 'An amount set aside must be zero or more' using errcode = 'invalid_parameter_value';
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
    -- its first cost, if that is later) - except a kind given a new amount.
    select coalesce(jsonb_agg(jsonb_build_object(
             'kind', cl.kind, 'label', cl.label, 'amount_egp', cl.amount_egp,
             'overrides', coalesce((
               select jsonb_agg(jsonb_build_object('size', o.size, 'color', o.color, 'amount_egp', o.amount_egp))
                 from public.cost_line_overrides o where o.line_id = cl.id), '[]'::jsonb)
           ) order by cl.position), '[]'::jsonb)
      into v_kept
      from public.cost_lines cl
     where cl.kind <> 'cost'
       and not (cl.kind = 'loss_reserve' and p_loss_reserve is not null)
       and not (cl.kind = 'gift_reserve' and p_gift_reserve is not null)
       and cl.sheet_id = (
         select s.id from public.cost_sheets s
          where s.product_id = v_product
          order by (s.effective_from <= p_effective_from) desc,
                   case when s.effective_from <= p_effective_from then s.effective_from end desc,
                   s.effective_from asc
          limit 1);

    if p_loss_reserve > 0 then
      v_kept := v_kept || jsonb_build_object('kind', 'loss_reserve', 'label', 'مخصص خسائر الشحن', 'amount_egp', p_loss_reserve);
    end if;
    if p_gift_reserve > 0 then
      v_kept := v_kept || jsonb_build_object('kind', 'gift_reserve', 'label', 'مخصص الهدايا', 'amount_egp', p_gift_reserve);
    end if;

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

revoke execute on function public.apply_production_run(uuid, uuid[], date, numeric, numeric) from public, anon;
grant execute on function public.apply_production_run(uuid, uuid[], date, numeric, numeric) to authenticated, service_role;
