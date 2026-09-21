-- ---------------------------------------------------------------------------
-- A packaging charge is not a refused delivery.
--
-- v_refusal_costs counted every settlement line that was not a delivery. That
-- was right until statements gained named adjustments, and now a packaging
-- charge or a correction from last month lands in the table that answers
-- "what are refusals costing us" - the number this business watches most
-- closely, since a refusal costs a full shipping fee and refusals run above
-- average here.
--
-- Left alone it would have inflated the cost of refusing, quietly, by
-- whatever the courier happened to charge for other things that month.
-- ---------------------------------------------------------------------------

create or replace view public.v_refusal_costs
with (security_invoker = on) as
select
  date_trunc('month', s.received_at::timestamptz)::date as month,
  sl.outcome,
  count(*) as occurrences,
  sum(sl.fee_egp) as fees_egp,
  sum(-sl.net_egp) filter (where sl.net_egp < 0) as cost_egp
from public.settlement_lines sl
join public.courier_settlements s on s.id = sl.settlement_id
where sl.outcome not in ('delivered', 'adjustment')
group by 1, 2;
