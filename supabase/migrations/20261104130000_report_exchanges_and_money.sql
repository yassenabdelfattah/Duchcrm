-- Net sales count an exchange once, and the reports say what money came in and
-- what is still with the courier (2026-11-04).
--
-- An exchange took the old piece's value off twice. Its replacement carries
-- that value as a discount - the credit, so the order asks the customer for the
-- difference alone (#13) - and the old piece coming back is also a return at
-- what it sold for. #1407's 550 hoodie for W2610-00044's 700 jacket: the
-- customer has a 700 jacket and paid 700 for it, and the reports counted 150 -
-- 550 + 150 - 550. In October 3,550 of credits were taken off twice this way,
-- and 1,500 so far in November.
--
-- Counted the way Shopify counts an exchange (the owner's way, 2026-10-28):
-- the old piece is a return, and the new piece a sale at its price. So in the
-- reports a replacement's credit is not a discount: its lines are worth what
-- they sold for, and a piece of a replacement that is exchanged again comes
-- back at that worth. 550 - 550 + 700 = 700. The order's own money - what the
-- customer is asked for - is untouched.
--
-- And an exchange whose replacement was cancelled took nothing back: the old
-- piece stayed with the customer (W2611-00064). It is no return in the reports.
--
-- Two views for the money:
--   v_report_money_in        what came in, on the day it came: Accurate's
--                            transfers on their statement's date, and every
--                            other payment on the day the order was marked
--                            paid; less what was paid back to customers.
--   v_money_with_couriers    what the couriers hold now (the owner's choice:
--                            today, whatever the order's date) - collected
--                            and not yet on a reviewed statement, or still out.

-- --- Net sales ---------------------------------------------------------------------------

-- As in 20261102110000, a replacement's lines at what they sold for: its
-- credit is the old piece coming back, which is a return of its own.
create or replace view public.v_report_lines
with (security_invoker = on) as
SELECT li.id AS line_id,
    o.id AS order_id,
    o.order_number,
    (o.created_at AT TIME ZONE 'Africa/Cairo'::text)::date AS placed_on,
    o.channel::text AS channel,
    o.payment_method::text AS payment_method,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    o.customer_id,
    v.product_id,
    COALESCE(p.title, li.title) AS product_title,
    li.variant_id,
    li.sku,
    v.size,
    v.color,
    li.quantity,
    round(li.unit_price_egp * li.quantity::numeric, 2) AS gross_egp,
    round(li.unit_price_egp * li.quantity::numeric, 2) - nl.net_egp AS discounts_egp,
    nl.net_egp
   FROM order_line_items li
     JOIN orders o ON o.id = li.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN variants v ON v.id = li.variant_id
     LEFT JOIN products p ON p.id = v.product_id
     CROSS JOIN LATERAL ( SELECT round(li.total_egp *
                CASE
                    WHEN o.subtotal_egp > 0::numeric THEN (o.total_egp + CASE WHEN o.exchange_for_order_id IS NOT NULL THEN o.discount_egp ELSE 0::numeric END) / o.subtotal_egp
                    ELSE 1::numeric
                END, 2) AS net_egp) nl
  WHERE o.archived_at IS NULL AND o.cancelled_at IS NULL AND o.fulfillment_status <> 'cancelled'::fulfillment_status;

-- As in 20261102110000, a piece of a replacement at the same worth; and not
-- the old piece of an exchange whose replacement was cancelled before it came back.
create or replace view public.v_report_returns
with (security_invoker = on) as
SELECT rl.id AS return_line_id,
    r.id AS return_id,
    o.id AS order_id,
    o.order_number,
    (COALESCE(r.received_at, r.courier_reported_at, r.created_at) AT TIME ZONE 'Africa/Cairo'::text)::date AS returned_on,
    r.type::text AS return_type,
    r.reason::text AS reason,
    o.channel::text AS channel,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    o.customer_id,
    v.product_id,
    COALESCE(p.title, li.title) AS product_title,
    rl.variant_id,
    rl.sku,
    v.size,
    v.color,
    rl.quantity_expected AS quantity,
    round(
        CASE
            WHEN li.quantity > 0 THEN li.total_egp *
            CASE
                WHEN o.subtotal_egp > 0::numeric THEN (o.total_egp + CASE WHEN o.exchange_for_order_id IS NOT NULL THEN o.discount_egp ELSE 0::numeric END) / o.subtotal_egp
                ELSE 1::numeric
            END / li.quantity::numeric
            ELSE 0::numeric
        END * rl.quantity_expected::numeric, 2) AS value_egp
   FROM return_lines rl
     JOIN returns r ON r.id = rl.return_id
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN order_line_items li ON li.id = rl.order_line_item_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN variants v ON v.id = rl.variant_id
     LEFT JOIN products p ON p.id = v.product_id
  WHERE o.archived_at IS NULL AND rl.quantity_expected > 0 AND NOT (r.type = 'exchange'::return_type AND r.received_at IS NULL AND (EXISTS ( SELECT 1
           FROM orders x
          WHERE x.id = r.replacement_order_id AND (x.cancelled_at IS NOT NULL OR x.fulfillment_status = 'cancelled'::fulfillment_status))));

-- --- Money that came in -------------------------------------------------------------------

create or replace view public.v_report_money_in
with (security_invoker = on) as
-- Accurate's transfers, on the day the money arrived: what was received, or
-- the statement's own net when that was not typed. A draft is still being
-- entered and checked, and counts once it is reviewed.
select
  'courier_transfer'::text as source,
  coalesce(s.received_at, s.statement_date, (s.created_at at time zone 'Africa/Cairo')::date) as received_on,
  s.id as ref_id,
  s.reference as label,
  null::uuid as order_id,
  coalesce(s.net_received_egp, t.net_egp, 0)::numeric(12, 2) as amount_egp
from public.courier_settlements s
left join public.v_settlement_totals t on t.settlement_id = s.id
where s.status <> 'draft'

union all

-- Every other order paid, on the day it was marked paid (the last time, if its
-- payment was reopened; the day it was rung up, if it was paid there and
-- then): what the customer paid - the goods and the shipping, less a piece
-- refused at the door or taken off a tab. Not one whose cash was in one of
-- the transfers above.
select
  case
    when sh.id is null then 'shop'
    when sh.courier = 'own' then 'own_driver'
    when sh.cod_amount_egp = 0 then 'paid_before_shipping'
    else 'courier_by_hand'
  end,
  (coalesce(p.paid_at, o.created_at) at time zone 'Africa/Cairo')::date,
  o.id,
  o.order_number,
  o.id,
  (o.total_egp + o.shipping_egp - public.order_returned_off_egp(o.id))::numeric(12, 2)
from public.orders o
left join lateral (
  select s.id, s.courier, s.cod_amount_egp
    from public.shipments s
   where s.order_id = o.id and s.direction = 'outbound' and s.status <> 'cancelled'
   order by s.created_at desc
   limit 1
) sh on true
left join lateral (
  select max(e.created_at) as paid_at
    from public.order_events e
   where e.order_id = o.id and e.event_type = 'payment_change' and e.to_payment = 'paid'
) p on true
where o.payment_status = 'paid'
  and o.archived_at is null
  and o.cancelled_at is null
  and o.fulfillment_status <> 'cancelled'
  and not exists (
    select 1
      from public.settlement_lines sl
      join public.courier_settlements cs on cs.id = sl.settlement_id
     where sl.order_id = o.id and sl.collected_egp > 0 and cs.status <> 'draft')

union all

-- Paid back for pieces returned, on the day it was paid.
select 'refund', (r.refunded_at at time zone 'Africa/Cairo')::date, r.id, o.order_number, o.id, -r.refund_egp
from public.returns r
join public.orders o on o.id = r.order_id
where r.refund_egp > 0 and r.refunded_at is not null and o.archived_at is null

union all

-- An exchange's credit left over, handed back.
select 'refund', (o.exchange_refunded_at at time zone 'Africa/Cairo')::date, o.id, o.order_number, o.id, -o.exchange_refund_egp
from public.orders o
where o.exchange_refund_egp > 0 and o.exchange_refunded_at is not null and o.archived_at is null;

comment on view public.v_report_money_in is
  'Money that came in, one row per transfer or payment, on the Cairo day it came: '
  'Accurate''s reviewed statements, every other order marked paid, and refunds paid '
  'back (negative).';

-- --- Money with the couriers ---------------------------------------------------------------

create or replace view public.v_money_with_couriers
with (security_invoker = on) as
select
  s.id as shipment_id,
  o.id as order_id,
  o.order_number,
  s.courier,
  s.tracking_number,
  s.driver_name,
  case when o.fulfillment_status = 'delivered' then 'collected' else 'out' end as state,
  -- Delivered: what the customer paid at the door - the goods and shipping,
  -- less any piece they refused. Still out: what the label asks for.
  (case when o.fulfillment_status = 'delivered'
        then o.total_egp + o.shipping_egp - public.order_returned_off_egp(o.id)
        else s.cod_amount_egp end)::numeric(12, 2) as amount_egp,
  coalesce(s.delivered_at, s.handed_over_at) as since,
  extract(epoch from now() - coalesce(s.delivered_at, s.handed_over_at)) / 86400 as days,
  coalesce(o.ship_name, c.full_name) as customer_name
from public.shipments s
join public.orders o on o.id = s.order_id
left join public.customers c on c.id = o.customer_id
where s.direction = 'outbound'
  and s.status <> 'cancelled'
  and s.cod_amount_egp > 0
  and o.payment_status = 'pending'
  and o.cancelled_at is null
  and o.archived_at is null
  and (
    -- The courier collected it and has not paid it yet: on no statement but a
    -- draft. Our own drivers hand the cash in as they deliver.
    (o.fulfillment_status = 'delivered'
     and s.courier <> 'own'
     and not exists (
       select 1
         from public.settlement_lines sl
         join public.courier_settlements cs on cs.id = sl.settlement_id
        where sl.order_id = o.id and cs.status <> 'draft'))
    -- Out with a courier or our driver, still to collect.
    or (o.fulfillment_status in ('in_transit', 'out_for_delivery') and s.handed_over_at is not null)
  );

comment on view public.v_money_with_couriers is
  'Cash a courier or our driver holds now or is out to collect: delivered and not on '
  'a reviewed statement (collected), or still on the road (out).';
