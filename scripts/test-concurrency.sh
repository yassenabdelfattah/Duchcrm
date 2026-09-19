#!/usr/bin/env bash
#
# Two cashiers, one hoodie.
#
# This cannot be written as a pgTAP test, because pgTAP runs everything inside
# a single transaction and the thing being tested is what happens between two
# separate connections. So it is a script that opens two.
#
# Cashier A starts a sale and holds its transaction open for three seconds.
# Cashier B tries to sell the same last unit one second later. B must block on
# the row lock, then be refused once A commits.
#
# Every run is independent: stock is forced to exactly one, and the assertions
# only count orders created by this run. An earlier version counted every
# race-key order ever created and reported PASS on a leftover from a previous
# run while both cashiers had actually failed.
#
# Requires: a running local stack (`supabase start`) and psql.

set -uo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

LOCATION='ffffffff-0000-0000-0000-000000000001'
PRODUCT='ffffffff-0000-0000-0000-000000000002'
VARIANT='ffffffff-0000-0000-0000-000000000003'
RUN_ID="$(date +%s)$$"

echo "Run $RUN_ID - setting stock to exactly one unit..."

psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
insert into public.locations (id, name, type, is_active)
values ('$LOCATION', 'Race Test Shop', 'store', true)
on conflict (id) do nothing;

insert into public.products (id, title)
values ('$PRODUCT', 'Race Test Hoodie')
on conflict (id) do nothing;

insert into public.variants (id, product_id, sku, price_egp)
values ('$VARIANT', '$PRODUCT', 'RACE-TEST-HOOD', 1000)
on conflict (id) do nothing;

-- A DO block rather than a conditional SELECT, so the adjustment is
-- unmistakably executed rather than silently skipped by an empty result.
do \$\$
declare
  v_current integer;
  v_delta   integer;
begin
  select coalesce(quantity, 0) into v_current
    from public.stock_levels
   where variant_id = '$VARIANT' and location_id = '$LOCATION';

  v_delta := 1 - coalesce(v_current, 0);

  if v_delta <> 0 then
    perform public.record_stock_movements(
      '$LOCATION', 'adjustment',
      jsonb_build_array(jsonb_build_object(
        'variant_id', '$VARIANT', 'quantity_delta', v_delta
      )),
      'concurrency_test', '$RUN_ID'
    );
  end if;
end
\$\$;
SQL

if [ $? -ne 0 ]; then
  echo "FAIL: could not set up the fixture"
  exit 1
fi

BEFORE=$(psql "$DB_URL" -tAX -c \
  "select quantity from public.stock_levels where variant_id = '$VARIANT' and location_id = '$LOCATION';")
echo "Stock before: $BEFORE"

# Without this the race is meaningless - two cashiers failing because there was
# never any stock would look identical to the lock working.
if [ "$BEFORE" != "1" ]; then
  echo "FAIL: setup did not leave exactly one unit in stock (got '$BEFORE')"
  exit 1
fi

SALE_A="begin;
select (public.create_store_sale('$LOCATION','cash',
  '[{\"variant_id\":\"$VARIANT\",\"quantity\":1}]'::jsonb,
  'race-$RUN_ID-A')).order_number;
select pg_sleep(3);
commit;"

SALE_B="select pg_sleep(1);
select (public.create_store_sale('$LOCATION','cash',
  '[{\"variant_id\":\"$VARIANT\",\"quantity\":1}]'::jsonb,
  'race-$RUN_ID-B')).order_number;"

OUT_A=$(mktemp)
OUT_B=$(mktemp)

psql "$DB_URL" -tAX -c "$SALE_A" >"$OUT_A" 2>&1 &
PID_A=$!
psql "$DB_URL" -tAX -c "$SALE_B" >"$OUT_B" 2>&1 &
PID_B=$!

wait $PID_A
wait $PID_B

echo
echo "--- cashier A ---"; cat "$OUT_A"
echo "--- cashier B ---"; cat "$OUT_B"
echo

AFTER=$(psql "$DB_URL" -tAX -c \
  "select quantity from public.stock_levels where variant_id = '$VARIANT' and location_id = '$LOCATION';")

# Scoped to this run only.
SOLD=$(psql "$DB_URL" -tAX -c \
  "select count(*) from public.orders
    where idempotency_key like 'race-$RUN_ID-%'
      and fulfillment_status = 'delivered';")

echo "Stock after: $AFTER"
echo "Sales completed in this run: $SOLD"
echo

FAILURES=0

if [ "$AFTER" != "0" ]; then
  echo "FAIL: stock should be 0, is $AFTER"
  FAILURES=$((FAILURES + 1))
fi

if [ "$SOLD" != "1" ]; then
  echo "FAIL: exactly one sale should have completed, got $SOLD"
  FAILURES=$((FAILURES + 1))
fi

if ! grep -qi 'insufficient_stock' "$OUT_B"; then
  echo "FAIL: the second cashier should have been refused with insufficient_stock"
  FAILURES=$((FAILURES + 1))
fi

if grep -qi 'insufficient_stock\|ERROR' "$OUT_A"; then
  echo "FAIL: the first cashier should have succeeded"
  FAILURES=$((FAILURES + 1))
fi

rm -f "$OUT_A" "$OUT_B"

if [ "$FAILURES" -eq 0 ]; then
  echo "PASS: one sale went through, the other was refused, stock is correct."
  exit 0
fi

exit 1
