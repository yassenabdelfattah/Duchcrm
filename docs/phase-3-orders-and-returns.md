# Phase 3 — orders, packing, shipping and returns

**Status: schema built, migrations applied and tests passing. Screens not yet built.**

One question is still open, marked **[?]** at the end.

---

## How Duch actually operates

Everything below follows from this, so it is recorded first.

**The daily rhythm.** A pickup car comes every day. It takes the day's outbound
parcels, and on the same run it brings back whatever returns have accumulated
at the courier's nearest station — batched, not one at a time. So checking
returns in is a batch job, several parcels at once, not a one-off event.

**Every order is confirmed by phone before it ships**, cash on delivery or not.

**Refusals are above average**, and they are the main source of returns. Two
reasons dominate: the customer never responds, and the customer opens the
parcel at the door and decides they do not want it. Sizing complaints are rare,
but have to be supported, as do exchanges.

**Timings.** Delivery runs three to five days, in Cairo and roughly as an
average elsewhere. A refusal comes back fast — on its way immediately, landing
within two or three days.

**Custody matters, and it is an anti-theft control.** A return is not processed
until the parcel is physically in the office. Until then the order stays open
and the goods are tracked as being with the courier, followed through the
courier's own app. Every piece is accounted for from the moment it leaves until
it comes back or is delivered.

**Money.** The courier transfers cash to the bank and sends a notification.
Their application shows the detail, and they issue a statement covering that
transfer, itemised per order, including which were returned or refused. It
cannot be exported from their app and is not available over an API.

**The accountant works on paper.** Today that means a WhatsApp message listing
each order the money came from, then handing over the cash. Returns, shipping
costs and non-responding customers go in the same message as minuses.

---

## 1. Two statuses, not one

`orders.status` is replaced by `fulfillment_status` and `payment_status`,
because with cash on delivery the goods and the money move on separate
timelines. An order is delivered on Tuesday; the cash arrives the following
week. One column cannot say "the customer has it, we have not been paid"
without a combined value for every pair.

### Fulfilment status

`awaiting_confirmation` → `confirmed` → `ready_to_pack` → `packed` →
`awaiting_pickup` → `in_transit` → `out_for_delivery` → `delivered`

with `delivery_failed` → `return_in_transit` → `returned` for the ones that
come back, and `cancelled` for those killed before they shipped.

A store sale is created already `delivered` and `paid` — the customer walked
out with it. It can still be voided at the counter; the guard that stops an
in-transit order being cancelled deliberately exempts the store channel.

### Payment status

`pending` → `paid`, plus `partially_refunded`, `refunded`, `failed`.

A COD order stays `pending` all the way through delivery and only becomes
`paid` when the settlement containing it is reviewed. That is the only place
an order becomes paid, which is what keeps "delivered" and "we have the money"
honestly separate.

### The confirmation call

`confirmation_outcome` (`confirmed`, `unreachable`, `cancelled_by_customer`,
`asked_to_delay`), `confirmation_attempts`, `confirmed_at`, `confirmed_by`, and
`hold_until` for when a customer asks to receive it later.

Since every order is called anyway, recording the outcome turns a habit into
something measurable — an order that was confirmed and still refused at the
door is telling you something quite different from one that was never reached.

---

## 2. Every transition is recorded

`order_events` holds each change with who, when and why. Written by a trigger
on `orders`, not by callers, so a transition cannot happen without leaving a
trace — including one made by hand in psql. Append-only, like the stock ledger.

This is what makes answerable: how long orders sit before packing, which have
been packed for days with no pickup, and who marked something delivered.

---

## 3. Custody

`shipments` carries the courier's own tracking code, the COD amount, and the
timestamps for handover, delivery, failure and return. A parcel is in custody
from `handed_over_at` until it is delivered or physically back.

**A parcel cannot be handed over without a tracking number.** The database
refuses it. A parcel with no code cannot be chased if it goes missing, which
defeats the entire point.

Until the Accurate integration exists, the packer records that code by hand —
and the barcode scanner built in Phase 2 reads it straight off their label.

### The exception list is the actual control

`v_courier_custody` shows everything outside the building right now, with a
piece count. `v_custody_exceptions` narrows it to what has stopped moving:
anything coming back for more than a week, or out for more than ten days.

Since a refusal normally lands within two or three days, a week is already
well past normal. The control is noticing that something stopped, not the
tracking itself.

### Check-in is per item, and it counts

A customer here can open a parcel, keep one item and hand the rest back. It is
not common, but it happens, so `return_lines` records expected, received,
resellable and damaged quantities per line, with `quantity_missing` derived.

Three went out, two came back, one missing → the return is marked
`discrepancy` rather than `received`, it stays open, and it appears on
`v_return_discrepancies` for someone to chase. This is the case the whole
custody design exists for.

Only the resellable quantity goes back into sellable stock. Damaged pieces are
recorded on the line and never returned to stock — they were already deducted
when the order shipped, so the write-off is the absence of a movement rather
than a second one.

---

## 4. Return reasons

Shaped around what actually happens here:

| Reason | Notes |
|---|---|
| `no_response` | Never answered, never scheduled. Small courier fee. |
| `refused_after_inspection` | Opened at the door and declined. **Full shipping fee.** |
| `refused_unopened` | |
| `wrong_address` | |
| `delivery_timeout` | Attempts exhausted. |
| `wrong_size` | Post-delivery. Rare here. |
| `not_as_expected` | Post-delivery. |
| `faulty` | Post-delivery. |
| `wrong_item_sent` | Ours, not theirs. A packing error to fix, not a customer decision to analyse. |

`refused_after_inspection` is separate from a plain refusal on purpose: the
garment was handled and the packaging opened, it costs a full shipping fee
rather than the small one, and it is the refusal that says the most about the
product — that customer saw the real thing and still said no.

Failed deliveries and post-delivery returns are reported separately. Merging a
door refusal with a size exchange would produce a rate that measures nothing
actionable.

---

## 5. Return percentage

Measured by **cohort** — of the orders handed over in a given week, what share
came back. Returns-this-month over orders-this-month understates the rate while
the business is growing and flatters it most in the best months.

**A cohort is final after 14 days.** Three to five days out plus two or three
back is about eight at the outside, so fourteen leaves comfortable margin.
`v_return_cohorts` flags anything younger as `is_mature = false` — still
collecting returns, and it will get worse.

Sliced by COD versus prepaid, governorate, product, size, customer and reason.
Given refusals are above average and mostly non-response, the per-customer and
per-governorate cuts are likely the most useful early.

### What refusals cost

`v_refusal_costs` sums what the courier actually charged, from the settlement
lines, rather than from an estimate. A refusal collects nothing and still costs
a full shipping fee, so its net is negative — that negative, summed over a
month, is the real number.

---

## 6. Settlements

The statement cannot be exported and there is no API, so it is entered by hand:
their statement on one side, the CRM on the other.

The design goal is to make entry short and then do the checking automatically.

**Entry is keyed on the courier's tracking code** — the only thing that appears
on both their statement and our records. It resolves straight to a shipment and
therefore to an order, and because the CRM already knows what that parcel was
worth, the expected amount fills itself in. The work becomes confirming rather
than transcribing: for a normal delivered line, the code and the fee.

Each line records what the courier collected at the door and what they charged
us. The customer pays shipping on top of the goods and it sits inside the COD
amount, so:

```
net to us = collected at the door − courier fee
```

A delivered order nets its goods value. A refusal collects nothing and still
costs a fee, so it nets negative.

**It will not close while it does not balance.** The amount that actually
landed in the bank is entered separately from the lines, and review is refused
if the two disagree. That refusal is the point — an unexplained difference is
exactly the thing that would otherwise be shrugged off. Reviewing marks every
delivered order in the statement `paid`.

### What the accountant gets

`v_settlement_statement` gives the line-by-line detail with the products in
each parcel, and `v_settlement_totals` the summary. Money in on one side,
returns and fees as minuses on the other, with a net at the bottom — the same
information as today's WhatsApp message, assembled rather than typed.

The screen should offer both a printable version and a plain-text copy, since
the message is what actually gets sent.

### Money is not for everyone

Settlements are readable only by admin and stock manager. Sales and packing
staff cannot see them at all, enforced by Row Level Security.

---

## 7. Exchanges

Physically: the replacement goes out on the daily pickup car, the courier swaps
it with the customer at the door, and the original comes back to the station
and returns to us batched on a later run.

So it is two movements of goods sharing one courier visit. Modelled as a return
plus a linked replacement order, which keeps the stock ledger honest at both
ends: one garment leaves, a different one comes back, each with its own
condition check. The replacement carries no money — the customer already paid
for the original.

---

## 8. Customer reliability

`v_customer_reliability` gives orders placed, delivered, refused and the
refusal rate per customer, and `customers.requires_prepayment` is a flag an
admin sets by hand.

The packing queue shows prior refusals next to each order, so the decision
about someone who has refused twice before is made *before* a courier run is
paid for rather than after.

---

## 9. Alerts

Supabase Realtime, moved up from Phase 5 because it is what keeps the queue
current for someone with the CRM open all day.

- A new order appears in the queue without a refresh, with a badge and a sound.
- An order packed but not collected for two days.
- A parcel that has stopped moving — the custody exception.
- A settlement that has not arrived when expected.

---

## 10. Two printed documents

- **Packing slip** — ours, listing what goes in the box. Bilingual, prints from
  the CRM.
- **Airway bill** — Accurate's, with their barcode and tracking number,
  generated by their system.

---

## The one question still open

**[?] After someone opens a parcel and refuses it, does the garment normally go
straight back into sellable stock, or does it need repackaging first?** And if
it does, is that worth recording as a cost?

The schema already handles either answer — check-in splits what came back into
resellable and damaged — so this only changes whether the screen asks a third
question and whether repackaging shows up in the cost of a refusal.

---

## What is built, and what is blocked

**Built and tested:** the two status fields, the confirmation-call fields, the
`order_events` history, shipments and custody, returns with per-item check-in,
exchanges, settlements with the balance check, and the reporting views.

**Still to build, and not blocked:** the Shopify order webhooks (payloads have
been stored since Phase 2, so any that already arrived can be replayed rather
than lost), the packing queue screen, the batch return check-in screen, the
settlement entry screen, realtime alerts, and the packing slip.

**Blocked on Accurate's documentation:** creating the pickup order, their
airway bill, and tracking updates — and therefore every status from
`in_transit` onwards. Until then those transitions are driven by hand, which
also means the packing workflow can go live before the courier integration
exists at all.
