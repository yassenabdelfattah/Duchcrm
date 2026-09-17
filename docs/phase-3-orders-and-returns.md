# Phase 3 — orders, packing, shipping and returns

**Status: draft. Captured from a requirements conversation, not yet built.**

Open questions are marked **[?]**. Several of them change the schema, so they
are worth settling before any migration is written.

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

## 1. Two statuses, not one

The current `order_status` enum (`draft, confirmed, completed, cancelled,
refunded`) mixes two questions that move independently:

- **Where are the goods?**
- **Where is the money?**

With cash on delivery those come apart badly. An order can be *delivered* while
the cash is still sitting with the courier for another week. One enum cannot
express "the customer has it, we have not been paid" without inventing a
combined value for every pair.

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
| `return_in_transit` | Coming back to us | Tracking poll |
| `returned` | Physically back and checked in | Packer |
| `cancelled` | Killed before it shipped | Staff or Shopify |

### Payment status

`pending`, `paid`, `partially_refunded`, `refunded`, `failed`.

A prepaid card order is `paid` from the start. A COD order stays `pending`
through delivery and only becomes `paid` when Accurate actually remits the
cash — which is the point of the next question.

**[?] How does Accurate tell you what they have collected?** A settlement
report, a statement, a spreadsheet, an API endpoint? This decides whether there
needs to be a `courier_settlements` table matching remittances to orders. Until
COD money is reconciled against orders, "delivered" and "paid for" are
different sets and nobody is chasing the gap between them.

---

## 2. Status changes are recorded, not overwritten

Same principle as the stock ledger: an `order_events` table holding every
transition with who, when and why, rather than a column that gets overwritten.

This is not bookkeeping for its own sake. It is what makes these answerable:

- How long do orders sit before they are packed?
- Which orders have been `packed` for three days with no pickup?
- Who marked this delivered, and when?

None of that is recoverable from a status column.

---

## 3. Returns are two different things

This is the point that matters most. Merging the two would make the return
percentage useless for both purposes.

### Failed delivery — the customer never accepted it

Refused at the door, unreachable, wrong address. They never had the goods and
never paid. Common with COD, and in Egyptian e-commerce usually the larger of
the two by a wide margin.

What a high number tells you: something is wrong upstream — address quality,
the confirmation call, delivery timing, or people ordering on impulse and
changing their mind before the van arrives.

### Post-delivery return — they had it and sent it back

Wrong size, did not like it, faulty, wrong item sent.

What a high number tells you: something about the product — sizing guidance,
photography, fabric description, or quality control.

**These belong in separate buckets.** A single rate that merges a COD refusal
with a size exchange measures nothing you can act on.

### Return reasons

`refused_at_door`, `customer_unreachable`, `wrong_address`, `delivery_timeout`,
`changed_mind`, `wrong_size`, `not_as_expected`, `faulty`, `wrong_item_sent`.

---

## 4. Stock comes back when the box does, not when the courier says so

When tracking flips to "returning", the goods are in a van. They are not
sellable, and they may never arrive.

So `return_in_transit` moves no stock. The movement happens at `returned`, when
someone has the parcel open in front of them. Restocking earlier means the
website sells a hoodie that is somewhere on the ring road.

Check-in has three outcomes per item:

- **Resellable** — a `return` movement, back into sellable stock.
- **Damaged** — recorded, but not returned to sellable stock.
- **Missing** — the parcel came back short. Recorded and investigated.

**[?] Do damaged returns need to be a quantity you can see and act on** — a
damaged bucket you can count and write off periodically — or is a one-line
write-off with a note enough? The first needs its own stock state; the second
is just an `adjustment` movement.

---

## 5. Return percentage, and the trap in it

The naive version — returns this month divided by orders this month — is wrong
in a way that flatters you while you are growing.

An order shipped on the 28th can come back on the 12th of the next month. If
the business is growing, this month's denominator is large while this month's
returns mostly belong to last month's smaller shipments. The rate looks lower
than it really is, and it looks best exactly when you are growing fastest.

The fix is to measure by **cohort**: of the orders shipped in a given week or
month, what share eventually came back. That is accurate, but it takes a few
weeks to mature, so recent cohorts must be labelled as still moving rather than
shown as though final.

**[?] Roughly how long between shipping and a return being resolved?** Two
weeks, a month? That sets the point at which a cohort is treated as settled.

### What to slice it by

Each of these has a different fix behind it:

| Slice | What a high number points at |
|---|---|
| COD vs prepaid | A funnel problem, not a product problem |
| Governorate | Coverage or address quality in one area |
| Product and variant | Sizing or description on that item |
| Size within a product | The size chart is wrong for that garment |
| Customer | A few people who order and refuse repeatedly |
| Reason | Whether the cause is upstream or in the product |

The per-customer one is worth having early — a repeat refuser can be flagged
before the next COD order ships.

---

## 6. Alerts

"CRM open all the time, new orders should appear" is Supabase Realtime, which
was planned for Phase 5 alongside staff chat. It moves here, because it is the
mechanism behind the packing queue keeping itself current.

- A new order arrives by webhook and appears in the queue without a refresh.
- A badge count in the navigation, and a sound.
- Optionally a browser notification, so it is noticed when the tab is behind
  others.

**[?] Should anything else raise an alert** — an order packed but not collected
for two days, a failed delivery, a COD settlement that has not arrived? These
are the cases where silence is the problem, and silence is what nobody notices.

---

## 7. Two different printed documents

"Print the shipping slip" could mean either of these, and they come from
different places:

- **Packing slip** — ours. Lists what goes in the box, for the packer to check
  against and for the customer to find inside. Bilingual, prints from the CRM.
  Can be built now.
- **Airway bill / courier label** — Accurate's, carrying their barcode and
  tracking number. Usually generated by their system when the pickup order is
  created. Some couriers return a PDF to print; others return data to lay out
  ourselves.

**[?] Which did you mean, or both?** And if Accurate returns a label, in what
form?

---

## What can be built before the Accurate documentation arrives

Buildable now:

- The two status fields and the `order_events` history.
- Shopify order webhooks — `orders/create`, `orders/updated`,
  `orders/cancelled`, `refunds/create`. Their payloads have been stored since
  Phase 2, so any that have already arrived can be replayed rather than lost.
- The packing queue screen and the daily workflow up to the pickup step.
- Realtime alerts.
- The returns model, check-in, and restocking.
- Return percentage reporting.
- The packing slip.

Blocked on Accurate:

- Creating the pickup order.
- Their airway bill.
- Tracking updates, and therefore every status from `in_transit` onwards.
- COD settlement reconciliation.

The status flow is deliberately shaped so the courier integration slots into
the middle of it. Until it exists those transitions can be driven by hand,
which also means the packing workflow can go live before the courier
integration is finished.
