-- ---------------------------------------------------------------------------
-- Let packing staff put returned stock back.
--
-- Checking parcels back in is the packing role's job - it is the person
-- standing at the table with the pile from the daily car. But the `return`
-- reason was grouped with adjustments and production receipts, which only a
-- stock manager may record, so a packer could open the check-in screen, count
-- everything, and then be refused at the last step.
--
-- The grouping was wrong rather than the rule. A return records goods that
-- have physically arrived and been counted; an adjustment is someone deciding
-- a number should be different. Those deserve different permissions.
-- ---------------------------------------------------------------------------

create or replace function public.assert_can_move_stock(p_reason public.stock_movement_reason)
returns void
language plpgsql
stable
as $$
declare
  v_role public.staff_role;
begin
  -- Edge Functions and the Worker use the service role key. They carry no end
  -- user, and they are the only callers allowed to record online_order and
  -- cancellation movements.
  if public.is_service_request() then
    return;
  end if;

  v_role := public.auth_role();

  if v_role is null then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  if v_role = 'admin' then
    return;
  end if;

  case p_reason
    -- Selling at the counter.
    when 'store_sale' then
      if v_role in ('sales', 'stock_manager') then return; end if;

    -- Goods physically back on the table and counted. The packer doing the
    -- counting is the one recording it.
    when 'return' then
      if v_role in ('packing', 'stock_manager') then return; end if;

    -- Deciding a number should be different, or booking in production. Both
    -- are judgement calls rather than observations, so they stay with the
    -- stock manager.
    when 'adjustment', 'production_in', 'initial_import', 'wholesale' then
      if v_role = 'stock_manager' then return; end if;

    else
      null;
  end case;

  raise exception 'Role % may not record a % movement', v_role, p_reason
    using errcode = 'insufficient_privilege';
end;
$$;
