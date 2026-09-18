# Phase 3 — orders, packing, shipping and returns

**Status: draft, being refined in conversation. Not yet built.**

Open questions are marked **[?]**. The ones left change the schema, so they are
worth settling before any migration is written.

---

## The daily job this has to support

One person has the CRM open all day. When they arrive:

1. See which orders came in and need packing.
2. Pack them.
3. Create the pickup order with Accurate.
4. Print the slip.
5. Hand the parcels over when the courier arrives.

Then, continuously: new website orders should announce themselves rather than
needing the page refreshed.

---

## What we know about how Duch actually operates

Recorded from the requirements conversation, because most of the design below
follows from it.

**Refusals are above average, and they are the main source of returns.** The
two dominant reasons are the customer not responding at all, and the customer
opening the parcel at the door and deciding they do not want it. Sizing
complaints are rare — but the system still has to handle them, and has to
handle exchanges.

**Timings.** Delivery runs three to five days, in Cairo and roughly as an
average elsewhere. A refusal comes back fast: the parcel is on its way back
immediately and lands within two or three days.

**Money.** Accurate transfers the cash to the bank account and sends a
notification. Their application shows the detail, and they issue a full
statement covering that transfer, broken down per order — including which ones
were returned, refused, or never answered. That statement gets reviewed, then
passed to the accountant along with the money detail so he can enter it in his
own ledger.

**Custody matters.** Returns are not processed until the parcel is physically
back in the office. Until then the order stays open and the goods are tracked
as being with the courier. This is deliberate and it is an anti-theft control,
not an accounting nicety — every piece is accounted for from the moment it
leaves the office until it comes back or is delivered.

---

## 1. Two statuses, not one

The current `order_status` enum (`draft, confirmed, completed, cancelled,
refunded`) mixes two questions that move independently:

- **Where are the goods?**
- **Where is the money?**

With cash on delivery those come apart badly. An order can be delivered while
the cash is still with the courier for another week. One enum cannot express
"the customer has it, we have not been paid" without inventing a combined value
for every pair.

So: keep `status` for the goods, add `payment_status` for the money.

### Fulfilment status

| Status | Meaning | Who sets it |
|---|---|---|
| `new` | Arrived, nobody has looked at it | Shopify webhook |
| `ready_to_pack` | Reviewed, stock confirmed, queued | Packer or automatic |
| `packed` | In a box, waiting for a pickup order | Packer |
| `awaiting_pickup` | Pickup order created, tracking number issued | Accurate integration |
| `in_transit` | Collected by the courier | Tracking poll |
| `out_for_delivery` | On the van | Tracking poll |
| `delivered` | Handed to the customer | Tracking poll |
| `delivery_failed` | Refused, unreachable, or bad address | Tracking poll |
| `return_in_transit` | Coming back to us, still in courier custody | Tracking poll |
| `returned` | Physically back, opened and counted | Packer |
| `cancelled` | Killed before it shipped | Staff or Shopify |

### Payment status

`pending`, `paid`, `partially_refunded`, `refunded`, `failed`.

A prepaid card order is `paid` from the start. A COD order stays `pending`
through delivery and only becomes `paid` when the settlement statement is
matched — see section 6.

---

## 2. Status changes are recorded, not overwritten

An `order_events` table holding every transition with who, when and why, rather
than a column that gets overwritten. Same principle as the stock ledger.

This is what makes these answerable:

- How long do orders sit before they are packed?
- Which orders have been `packed` for three days with no pickup?
- Which parcels have been coming back for longer than they should?
- Who marked this delivered, and when?

None of that is recoverable from a status column.

---

## 3. Custody: knowing where every piece is

The requirement is that nothing leaves the building untracked, so that a piece
cannot quietly go missing at the courier.

Every order line carries a count of what left and what came back. The parcel is
in courier custody from `in_transit` until either `delivered` or `returned`,
and a report lists everything currently in that window, aged.

Because a refusal comes back within two or three days, anything that has been
`return_in_transit` for, say, longer than a week is an exception worth a phone
call. **That aged list is the actual anti-theft control** — not the tracking
itself, but noticing when something has stopped moving.

### Check-in is per item, and counts

When the parcel is opened, the packer records what is actually in it, line by
line. A three-item order that comes back with two items is a discrepancy that
has to be recordable, visible, and chaseable. Each item is checked in as:

- **Resellable** — a `return` movement, back into sellable stock.
- **Damaged** — recorded, not returned to sellable stock.
- **Missing** — did not come back. Flagged, and it stays open.

Stock only moves at this point. Nothing goes back into sellable stock while it
is still in a van.

---

## 4. Return reasons, shaped around what actually happens

The two big ones first, because they are the ones Duch sees:

| Reason | What it means |
|---|---|
| `no_response` | Customer never answered. Parcel never opened. |
| `refused_after_inspection` | Opened at the door, did not want it. |
| `refused_unopened` | Refused without opening. |
| `wrong_address` | Could not be delivered. |
| `delivery_timeout` | Attempts exhausted, returned by the courier. |
| `wrong_size` | Post-delivery. Rare here, but supported. |
| `not_as_expected` | Post-delivery. |
| `faulty` | Post-delivery. |
| `wrong_item_sent` | Our mistake. Tracked separately — it is a packing error, not a customer decision. |

`refused_after_inspection` is worth its own reason rather than being folded in
with a plain refusal. The garment was handled, the packaging was opened, and it
may need repackaging before it can be sold again. It is also the reason that
says the most about the product itself, since the customer saw the real thing
and changed their mind.

**Failed deliveries and post-delivery returns are reported separately.** A
door refusal and a size exchange have different causes and different fixes, so
a rate that merges them measures nothing actionable.

---

## 5. Return percentage

### The timing trap

Returns this month divided by orders this month is wrong in a way that
flatters you while you are growing: an order shipped on the 28th can come back
in the next month, so the denominator is current and the numerator is stale.
It looks best exactly when you are growing fastest.

So it is measured by **cohort** — of the orders shipped in a given week, what
share eventually came back.

### When a cohort is settled

From the timings above: three to five days to attempt delivery, then two or
three days for a refusal to come back. That is about eight days at the outer
edge. **A shipping cohort is treated as final after 14 days**, which leaves
comfortable margin, and cohorts younger than that are shown as still moving
rather than as a finished number.

### What to slice it by

| Slice | What a high number points at |
|---|---|
| COD vs prepaid | A funnel problem, not a product problem |
| Governorate | Coverage or address quality in one area |
| Product and variant | Sizing or description on that item |
| Size within a product | The size chart is wrong for that garment |
| Customer | A few people who order and refuse repeatedly |
| Reason | Whether the cause is upstream or in the product |

Given that refusals are above average and mostly non-response, the per-customer
and per-governorate cuts are likely to be the most useful early.

### The cost of a refusal

A refused order is not free — there is the courier's return fee, the packaging,
and the handling. Tracking that gives a real figure for what refusals cost per
month, which is the number that justifies doing something about them.

---

## 6. The settlement and the accountant

This is the money side, and it is the part that currently happens by hand.

### The flow today

Accurate transfers cash to the bank and notifies. A statement covers that
transfer, itemised per order, including the ones that were returned or refused.
That statement is reviewed, then handed to the accountant with the detail so he
can post it to his ledger.

### What the CRM should do with it

A `courier_settlements` table: one row per transfer, holding the date, the
amount received, the reference, and a link to the statement document. Under it,
one row per order in that statement — what the courier says was collected, what
fee was deducted, and what the outcome was.

Matching that against our own orders answers the questions that are currently
answered by reading a spreadsheet carefully:

- Which delivered orders have not been paid for yet?
- Does the total on the statement agree with what we think those orders were
  worth?
- Which orders does the courier say were returned that we have not physically
  received back?

That last one is the custody check meeting the money check, and it is the one
worth having.

Marking a settlement reviewed flips every order in it to `paid`, and produces a
single export for the accountant with all the detail attached — replacing the
manual forward.

---

## 7. Exchanges

Rare compared to refusals, but must be supported.

The question is whether an exchange is modelled as a return plus a new linked
order, or as one operation. A return plus a linked outbound order keeps the
stock ledger honest — one garment comes back, a different one goes out — and
keeps the returned item's condition check in the normal flow.

**[?] How does an exchange physically happen?** Does the courier deliver the
replacement and collect the original in one visit, or does the customer send
the original back first and the replacement ship afterwards? That decides
whether the two orders are linked but independent, or have to move together.

---

## 8. Alerts

One person with the CRM open all day means Supabase Realtime, which was planned
for Phase 5 with staff chat. It moves here, because it is what keeps the
packing queue current.

- A new order appears in the queue without a refresh, with a badge and a sound.
- Optionally a browser notification, for when the tab is behind others.

Worth alerting on beyond new orders, because these are the cases where silence
is the problem:

- An order packed but not collected for two days.
- A parcel that has been coming back for longer than a week — the custody
  exception.
- A settlement that has not arrived when expected.

---

## 9. Two different printed documents

- **Packing slip** — ours. Lists what goes in the box, for the packer to check
  against and for the customer to find inside. Bilingual, prints from the CRM.
  Can be built now.
- **Airway bill / courier label** — Accurate's, carrying their barcode and
  tracking number. Generated by their system when the pickup order is created.

**[?] Which did you mean, or both?** And if Accurate returns a label, is it a
PDF to print, or data to lay out ourselves?

---

## Remaining open questions

**[?] What form does the statement come in?** A PDF, an Excel or CSV export
from their application, or something the API can return? This decides whether
reconciliation is automatic, a file upload, or typed in. It is the difference
between a few seconds and an afternoon, every time.

**[?] Can a customer accept part of an order and refuse the rest?** If someone
opens a two-item parcel and keeps only one, this has to be recordable per line
rather than per order. It changes the schema, so it is worth being sure.

**[?] Is there a confirmation call before shipping?** Many brands here ring COD
customers before dispatch, and non-response is the single largest refusal
reason above. If there is no confirmation step, adding one to the workflow may
do more for the refusal rate than anything else in this document. If there is,
it needs to be a status and its effect should be measured.

**[?] What does the courier charge for a failed delivery or a return,** and
does the statement show it per order? Needed for the real cost of a refusal.

**[?] Does the customer pay the shipping fee on top of the goods,** and is that
included in the COD amount the courier collects? Needed to reconcile the
statement against order totals.

**[?] After an opened-and-refused delivery, is the garment normally sellable
again?** Does it need repackaging, and does that have a cost worth recording?

**[?] What does the accountant actually need?** A PDF, a spreadsheet in a
particular layout, an import file for accounting software? The CRM can produce
it directly rather than having it assembled by hand.

**[?] Should repeat refusers be flagged,** and if so what should happen — a
warning on the order, or something stronger like requiring prepayment?

---

## What can be built before the Accurate documentation arrives

Buildable now:

- The two status fields and the `order_events` history.
- Shopify order webhooks — `orders/create`, `orders/updated`,
  `orders/cancelled`, `refunds/create`. Their payloads have been stored since
  Phase 2, so any that have already arrived can be replayed rather than lost.
- The packing queue screen and the daily workflow up to the pickup step.
- Realtime alerts.
- The returns model, the per-item check-in, and restocking.
- Custody tracking and the aged exception report.
- Return percentage reporting by cohort.
- The packing slip.

Blocked on Accurate:

- Creating the pickup order.
- Their airway bill.
- Tracking updates, and therefore every status from `in_transit` onwards.
- Settlement import, and therefore automatic COD reconciliation.

The status flow is deliberately shaped so the courier integration slots into
the middle of it. Until it exists those transitions can be driven by hand,
which also means the packing workflow can go live before the courier
integration is finished.
