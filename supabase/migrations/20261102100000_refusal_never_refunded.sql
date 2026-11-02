-- A piece refused at the door was never paid for, unless the order was paid
-- before it left (2026-11-02).
--
-- 20261102090000 counted a returned piece as owed back whenever the order was
-- paid. #1497 shows where that is wrong: a cash parcel, the customer kept the
-- L and refused the XL, and Accurate's statement - collected 1,580, the L and
-- the shipping - marked the order paid. Checking the XL in as refused then
-- read "paid", and would have owed the customer 1,500 they never paid.
--
-- A cash customer pays the courier for what they keep, and the statement marks
-- the order paid for that alone. So a refusal is owed back only when the
-- parcel carried nothing to collect: paid online, before it left.

create or replace function public.return_is_refunded(p_order_id uuid, p_type public.return_type)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_type <> 'exchange'
     and case
           when p_type = 'failed_delivery' then
             o.payment_status = 'paid'
             and not exists (
               select 1 from public.shipments sh
                where sh.order_id = o.id
                  and sh.direction = 'outbound'
                  and sh.status <> 'cancelled'
                  and sh.cod_amount_egp > 0)
           -- After delivery: paid in the CRM, or a cash parcel the courier
           -- collected at the door - paid by the customer even while the
           -- courier still holds the cash.
           else
             o.payment_status = 'paid'
             or exists (
               select 1 from public.shipments sh
                where sh.order_id = o.id
                  and sh.direction = 'outbound'
                  and sh.status <> 'cancelled'
                  and sh.courier <> 'own'
                  and sh.cod_amount_egp > 0)
         end
    from public.orders o
   where o.id = p_order_id;
$$;
