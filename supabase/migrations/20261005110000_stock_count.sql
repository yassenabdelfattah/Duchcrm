-- ---------------------------------------------------------------------------
-- A stock count: "we counted 7" rather than "add 2".
--
-- The owner's ask (2026-10-05): edit the stock of several sizes at once. For
-- goods arriving, the existing production_in movement already takes a list.
-- For a count it cannot be done safely in the browser: the screen would
-- subtract the number it loaded from the number typed, and a sale rung up in
-- between would be silently undone. So the difference is worked out here,
-- with the stock row locked, at the moment the count is saved.
--
-- Each size whose count differs gets an 'adjustment' movement for the
-- difference - the ledger is still only ever appended to - and a size counted
-- at what the system already says moves nothing.
-- ---------------------------------------------------------------------------

create or replace function public.record_stock_count(
  p_location_id     uuid,
  p_counts          jsonb,
  p_note            text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_location  uuid;
  v_item      jsonb;
  v_variant   uuid;
  v_counted   integer;
  v_current   integer;
  v_movements jsonb := '[]'::jsonb;
begin
  if not (public.has_permission('stock.adjust') or public.is_service_request()) then
    raise exception 'You may not adjust stock' using errcode = 'insufficient_privilege';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if jsonb_typeof(p_counts) <> 'array' or jsonb_array_length(p_counts) = 0 then
    raise exception 'Enter at least one count' using errcode = 'invalid_parameter_value';
  end if;

  v_location := coalesce(
    p_location_id,
    (select id from public.locations where is_default and is_active limit 1)
  );
  if v_location is null then
    raise exception 'No default location is configured to ship from' using errcode = 'no_data_found';
  end if;

  -- A second tap: the first one's movements are already there.
  if exists (select 1 from public.stock_movements where idempotency_key like p_idempotency_key || ':%') then
    return jsonb_build_object('changed', 0, 'repeat', true);
  end if;

  for v_item in select * from jsonb_array_elements(p_counts)
  loop
    v_variant := (v_item ->> 'variant_id')::uuid;
    v_counted := (v_item ->> 'counted')::integer;

    if not exists (select 1 from public.variants where id = v_variant) then
      raise exception 'Unknown variant %', v_variant using errcode = 'no_data_found';
    end if;

    if v_counted is null or v_counted < 0 then
      raise exception 'A count cannot be negative' using errcode = 'invalid_parameter_value';
    end if;

    -- Locked until this transaction ends, so a sale on the same size waits
    -- for the count instead of slipping in between the read and the write.
    select quantity into v_current
      from public.stock_levels
     where variant_id = v_variant and location_id = v_location
     for update;

    v_current := coalesce(v_current, 0);

    if v_counted <> v_current then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant,
        'quantity_delta', v_counted - v_current
      );
    end if;
  end loop;

  if jsonb_array_length(v_movements) = 0 then
    return jsonb_build_object('changed', 0);
  end if;

  perform public.record_stock_movements(
    p_location_id     => v_location,
    p_reason          => 'adjustment',
    p_movements       => v_movements,
    p_reference_type  => 'stock_count',
    p_reference_id    => null,
    p_note            => coalesce(nullif(trim(p_note), ''), 'Stock count'),
    p_idempotency_key => p_idempotency_key
  );

  return jsonb_build_object('changed', jsonb_array_length(v_movements));
end;
$$;

comment on function public.record_stock_count(uuid, jsonb, text, text) is
  'Sets sizes to a counted quantity by appending the difference as an '
  'adjustment, worked out with the stock row locked.';

revoke execute on function public.record_stock_count(uuid, jsonb, text, text) from public, anon;
grant execute on function public.record_stock_count(uuid, jsonb, text, text) to authenticated, service_role;
