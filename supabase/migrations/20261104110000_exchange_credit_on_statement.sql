-- An exchange on a courier statement is said to be one (2026-11-04).
--
-- The message to the accountant lists each product at its price and takes off
-- what customers did not pay for it, all as "discounts to customers". On
-- CSHP--030330 that was 550: W2610-00044 replaced #1407's faulty hoodie with a
-- 700 jacket, the hoodie paid 550 of it, and the courier collected the
-- difference. Nobody had been given a discount.
--
-- An exchange's replacement carries the returned piece's value as its
-- discount (create_exchange). So each statement line now says, on a
-- replacement, what that credit was and which order the piece came from, and
-- the message gives it its own line. Appended: exchange_for_order_number,
-- exchange_credit_egp.

create or replace view public.v_settlement_statement
with (security_invoker = on) as
SELECT s.id AS settlement_id,
    s.reference,
    s.received_at,
    s.status,
    sl.id AS line_id,
    sl.tracking_number,
    sl.outcome,
    sl.collected_egp,
    sl.fee_egp,
    sl.net_egp,
    o.order_number,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    ( SELECT string_agg((li.title || ' ×'::text) || li.quantity, ', '::text ORDER BY li.title) AS string_agg
           FROM order_line_items li
          WHERE li.order_id = sl.order_id) AS items,
    sl.note,
    sl.order_id,
    o.fulfillment_status AS order_status,
        CASE
            WHEN o.id IS NULL THEN NULL::text
            WHEN sl.outcome = 'delivered'::settlement_outcome THEN
            CASE
                WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN NULL::text
                WHEN o.fulfillment_status = ANY (ARRAY['returned'::fulfillment_status, 'return_in_transit'::fulfillment_status]) THEN 'crm_returned'::text
                ELSE 'crm_not_delivered'::text
            END
            WHEN sl.outcome = ANY (ARRAY['returned_refused'::settlement_outcome, 'returned_no_response'::settlement_outcome, 'returned_other'::settlement_outcome]) THEN
            CASE
                WHEN o.fulfillment_status = ANY (ARRAY['returned'::fulfillment_status, 'cancelled'::fulfillment_status]) THEN NULL::text
                WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN 'crm_delivered'::text
                ELSE 'not_back'::text
            END
            ELSE NULL::text
        END AS mismatch,
    sl.marked_paid,
    sl.customer_shipping_egp,
        CASE
            WHEN sl.outcome = 'delivered'::settlement_outcome AND sl.customer_shipping_egp > 0::numeric THEN sl.customer_shipping_egp - sl.fee_egp
            ELSE NULL::numeric
        END AS shipping_gain_egp,
    ( SELECT x.order_number
           FROM orders x
          WHERE x.id = o.exchange_for_order_id) AS exchange_for_order_number,
        CASE
            WHEN o.exchange_for_order_id IS NOT NULL AND o.discount_egp > 0::numeric THEN o.discount_egp
            ELSE NULL::numeric
        END AS exchange_credit_egp
   FROM courier_settlements s
     JOIN settlement_lines sl ON sl.settlement_id = s.id
     LEFT JOIN orders o ON o.id = sl.order_id
     LEFT JOIN customers c ON c.id = o.customer_id;
