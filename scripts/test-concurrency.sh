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
# Requires: a running local stack (`supabase start`). Uses psql if it is
# installed, and otherwise the one inside the database container.

set -uo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# psql is not always installed on the host - on Windows in particular the
# Supabase CLI ships no client binaries, so this script used to die at the
# first fixture with "psql: command not found". When it is missing, fall back
# to the psql inside the running database container: same version as the
# server, and nothing to install.
if command -v psql >/dev/null 2>&1; then
  run_psql() { psql "$@"; }
else
  DB_CONTAINER="$(docker ps --filter 'name=^supabase_db_' --format '{{.Names}}' 2>/dev/null | head -1)"

  if [ -z "$DB_CONTAINER" ]; then
    echo "FAIL: psql is not on PATH and no Supabase database container is running."
    echo "      Run 'supabase start', or install the Postgres client."
    exit 1
  fi

  # The container can only reach a database inside itself. A DATABASE_URL
  # pointing anywhere else would be silently ignored below, which is worse
  # than refusing - a remote database must not be raced against by accident.
  case "$DB_URL" in
    *127.0.0.1*|*localhost*) ;;
    *)
      echo "FAIL: psql is not on PATH, and DATABASE_URL points at a database the"
      echo "      container fallback cannot reach: $DB_URL"
      echo "      Install the Postgres client to run against that database."
      exit 1
      ;;
  esac

  # Inside the container the server listens on its own port, not the host's
  # published mapping.
  DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres"
  run_psql() { docker exec -i "$DB_CONTAINER" psql "$@"; }

  echo "psql not found on PATH - using the client inside $DB_CONTAINER."
fi

LOCATION='ffffffff-0000-0000-0000-000000000001'
PRODUCT='ffffffff-0000-0000-0000-000000000002'
VARIANT='ffffffff-0000-0000-0000-000000000003'
RUN_ID="$(date +%s)$$"

echo "Run $RUN_ID - setting stock to exactly one unit..."

run_psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL
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

BEFORE=$(run_psql "$DB_URL" -tAX -c \
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

run_psql "$DB_URL" -tAX -c "$SALE_A" >"$OUT_A" 2>&1 &
PID_A=$!
run_psql "$DB_URL" -tAX -c "$SALE_B" >"$OUT_B" 2>&1 &
PID_B=$!

wait $PID_A
wait $PID_B

echo
echo "--- cashier A ---"; cat "$OUT_A"
echo "--- cashier B ---"; cat "$OUT_B"
echo

AFTER=$(run_psql "$DB_URL" -tAX -c \
  "select quantity from public.stock_levels where variant_id = '$VARIANT' and location_id = '$LOCATION';")

# Scoped to this run only.
SOLD=$(run_psql "$DB_URL" -tAX -c \
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
