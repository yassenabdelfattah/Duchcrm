-- ---------------------------------------------------------------------------
-- Checking returns back in from the code on the parcel.
--
-- The scan has to work whether or not anybody recorded the failure when the
-- courier rang, because the common case is a pile of parcels on a table and
-- nobody having entered anything.
-- ---------------------------------------------------------------------------

begin;
select plan(16);

-- --- Fixtures --------------------------------------------------------------

insert into public.locations (id, name, type, is_default, is_active)
values ('e5e5e5e5-0000-0000-0000-000000000001', 'Return Test Shop', 'store', false, true);

insert into public.products (id, title)
values ('e5e5e5e5-0000-0000-0000-000000000002', 'Return Test Jacket');

insert into public.variants (id, product_id, sku, price_egp)
values ('e5e5e5e5-0000-0000-0000-000000000003',
        'e5e5e5e5-0000-0000-0000-000000000002', 'RET-JKT', 2000.00);

insert into public.customers (id, full_name, phone, governorate)
values ('e5e5e5e5-0000-0000-0000-00000000000c', 'Return Customer', '01599988877', 'Alexandria');

select public.record_stock_movements(
  'e5e5e5e5-0000-0000-0000-000000000001',
  'production_in',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-000000000003","quantity_delta":10}]'::jsonb
);

-- An order that went out with three pieces and is now with the courier.
insert into public.orders (
  id, order_number, channel, fulfillment_status, payment_status, location_id,
  customer_id, payment_method, subtotal_egp, shipping_egp, total_egp
)
values (
  'e5e5e5e5-0000-0000-0000-0000000000a1', public.next_order_number('online'), 'online',
  'in_transit', 'pending', 'e5e5e5e5-0000-0000-0000-000000000001',
  'e5e5e5e5-0000-0000-0000-00000000000c', 'cod', 6000, 70, 6000
);

insert into public.order_line_items (order_id, variant_id, sku, title, quantity, unit_price_egp, total_egp)
values ('e5e5e5e5-0000-0000-0000-0000000000a1', 'e5e5e5e5-0000-0000-0000-000000000003',
        'RET-JKT', 'Return Test Jacket', 3, 2000, 6000);

select public.record_stock_movements(
  'e5e5e5e5-0000-0000-0000-000000000001',
  'online_order',
  '[{"variant_id":"e5e5e5e5-0000-0000-0000-000000000003","quantity_delta":-3}]'::jsonb
);

insert into public.shipments (order_id, tracking_number, direction, status, cod_amount_egp, handed_over_at)
values ('e5e5e5e5-0000-0000-0000-0000000000a1', 'ACC-RET-0001', 'outbound', 'in_transit',
        6070, now() - interval '4 days');

-- --- A parcel on the table that nobody recorded ---------------------------

select is(
  public.lookup_return_by_tracking('ACC-RET-0001') ->> 'state',
  'needs_failure_record',
  'Scanning a parcel whose failure was never recorded says so, rather than failing'
);

select is(
  (public.lookup_return_by_tracking('ACC-RET-0001') #>> '{order_lines,0,quantity}')::int,
  3,
  'And still shows what went out, so the packer knows what to expect inside'
);

-- --- Recording it from the code in hand ------------------------------------

select lives_ok(
  $$ select public.record_delivery_failure_by_tracking(
       'ACC-RET-0001', 'refused_after_inspection', 'Opened at the door'
     ) $$,
  'The failure can be recorded from the code on the parcel'
);

select is(
  public.lookup_return_by_tracking('ACC-RET-0001') ->> 'state',
  'ready_to_receive',
  'The same scan now offers to check it in'
);

select is(
  (public.lookup_return_by_tracking('ACC-RET-0001') #>> '{lines,0,quantity_expected}')::int,
  3,
  'With all three pieces expected back'
);

select is(
  (select units_expected from public.v_returns_inbound
    where tracking_number = 'ACC-RET-0001'),
  3::bigint,
  'It appears on the list of what the courier owes us'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'e5e5e5e5-0000-0000-0000-000000000003'),
  7,
  'Recording the failure moved no stock - the goods are still in a van'
);

-- --- Two come back, one does not -------------------------------------------

select public.receive_return(
  (select id from public.returns where order_id = 'e5e5e5e5-0000-0000-0000-0000000000a1'),
  (
    select jsonb_build_array(jsonb_build_object(
      'return_line_id', rl.id,
      'quantity_resellable', 1,
      'quantity_damaged', 1,
      'condition_note', 'Scuffed sleeve'
    ))
    from public.return_lines rl
    join public.returns r on r.id = rl.return_id
    where r.order_id = 'e5e5e5e5-0000-0000-0000-0000000000a1'
  ),
  'Checked in from the daily return run'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'e5e5e5e5-0000-0000-0000-000000000003'),
  8,
  'Only the sellable piece went back into stock'
);

select is(
  (select status::text from public.returns
    where order_id = 'e5e5e5e5-0000-0000-0000-0000000000a1'),
  'discrepancy',
  'The parcel arrived short, so the return does not quietly close'
);

-- --- The missing piece turns up next week -------------------------------
--
-- A short parcel stays open on purpose, so it can be scanned again. The
-- check-in records only the difference, which is what stops a second count
-- from inventing stock.

select is(
  public.lookup_return_by_tracking('ACC-RET-0001') ->> 'state',
  'ready_to_receive',
  'A return still short can be scanned again, because the missing piece may arrive'
);

select public.receive_return(
  (select id from public.returns where order_id = 'e5e5e5e5-0000-0000-0000-0000000000a1'),
  (
    select jsonb_build_array(jsonb_build_object(
      'return_line_id', rl.id,
      'quantity_resellable', 2,
      'quantity_damaged', 1
    ))
    from public.return_lines rl
    join public.returns r on r.id = rl.return_id
    where r.order_id = 'e5e5e5e5-0000-0000-0000-0000000000a1'
  ),
  'The third one turned up'
);

select is(
  (select quantity from public.stock_levels
    where variant_id = 'e5e5e5e5-0000-0000-0000-000000000003'),
  9,
  'Only the one extra piece was added, not the whole parcel over again'
);

select is(
  (select status::text from public.returns
    where order_id = 'e5e5e5e5-0000-0000-0000-0000000000a1'),
  'received',
  'And now everything is accounted for, the return closes'
);

select is(
  public.lookup_return_by_tracking('ACC-RET-0001') ->> 'state',
  'already_received',
  'Scanning it once more says it is done'
);

select is_empty(
  $$ select return_id from public.v_returns_inbound
      where tracking_number = 'ACC-RET-0001' $$,
  'And it is off the list of what is still owed to us'
);

select is(
  (select units_missing from public.v_return_checkin_summary
    where received_date = (now() at time zone 'Africa/Cairo')::date),
  0::bigint,
  'The day''s summary shows nothing missing once the shortfall is resolved'
);

-- --- A code we have never seen --------------------------------------------

select is(
  public.lookup_return_by_tracking('NOT-A-REAL-CODE') ->> 'state',
  'not_found',
  'An unknown code says so plainly'
);

select * from finish();
rollback;
