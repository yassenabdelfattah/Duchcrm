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
# Requires: a running local stack (`supabase start`) and psql.

set -uo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

LOCATION='ffffffff-0000-0000-0000-000000000001'
PRODUCT='ffffffff-0000-0000-0000-000000000002'
VARIANT='ffffffff-0000-0000-0000-000000000003'

echo "Setting up one unit of stock…"

psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
delete from public.orders where idempotency_key like 'race-key-%';
insert into public.locations (id, name, type, is_active)
values ('$LOCATION', 'Race Test Shop', 'store', true)
on conflict (id) do nothing;

insert into public.products (id, title)
values ('$PRODUCT', 'Race Test Hoodie')
on conflict (id) do nothing;

insert into public.variants (id, product_id, sku, price_egp)
values ('$VARIANT', '$PRODUCT', 'RACE-TEST-HOOD', 1000)
on conflict (id) do nothing;

-- Bring stock to exactly one, whatever it was before.
select public.record_stock_movements(
  '$LOCATION', 'adjustment',
  jsonb_build_array(jsonb_build_object(
    'variant_id', '$VARIANT',
    'quantity_delta', 1 - coalesce(
      (select quantity from public.stock_levels
        where variant_id = '$VARIANT' and location_id = '$LOCATION'), 0)
  ))
) where 1 - coalesce(
  (select quantity from public.stock_levels
    where variant_id = '$VARIANT' and location_id = '$LOCATION'), 0) <> 0;
SQL

BEFORE=$(psql "$DB_URL" -tAX -c \
  "select quantity from public.stock_levels where variant_id = '$VARIANT' and location_id = '$LOCATION';")
echo "Stock before: $BEFORE"

SALE_A="begin;
select (public.create_store_sale('$LOCATION','cash',
  '[{\"variant_id\":\"$VARIANT\",\"quantity\":1}]'::jsonb,
  'race-key-A-$(date +%s)')).order_number;
select pg_sleep(3);
commit;"

SALE_B="select pg_sleep(1);
select (public.create_store_sale('$LOCATION','cash',
  '[{\"variant_id\":\"$VARIANT\",\"quantity\":1}]'::jsonb,
  'race-key-B-$(date +%s)')).order_number;"

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
SOLD=$(psql "$DB_URL" -tAX -c \
  "select count(*) from public.orders o
     join public.order_line_items li on li.order_id = o.id
    where li.variant_id = '$VARIANT' and o.status = 'completed'
      and o.idempotency_key like 'race-key-%';")

echo "Stock after: $AFTER"
echo "Completed sales of that variant: $SOLD"
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

rm -f "$OUT_A" "$OUT_B"

if [ "$FAILURES" -eq 0 ]; then
  echo "PASS: one sale went through, the other was refused, stock is correct."
  exit 0
fi

exit 1
