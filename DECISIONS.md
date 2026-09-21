# Decisions

Why things are built the way they are. If you are wondering "why not just do
the obvious thing?", the answer is probably here.

---

## 1. How stock stays in sync with Shopify

This is the heart of the system, so it is worth explaining slowly.

### The problem, in plain terms

You sell the same hoodie in two places: the shop, and the website. Both need to
agree on how many are left. If they disagree, either you sell something you do
not have, or a hoodie sits in the back room invisible to the website.

The old way of solving this was to write every sale down three times. The CRM
replaces that — but it creates a new problem, which is keeping two computers
in agreement instead of three notebooks.

### Rule one: there is one boss

The CRM decides how many hoodies exist. Shopify is told. Shopify never decides.

That sounds obvious, but it matters because it settles every argument in
advance. When the two disagree, we do not have to work out who is right in
principle — we only have to find out what happened.

### Rule two: nothing is ever edited, only added

Stock is not a number we change. It is a list of events:

```
Mon  +20  received from the factory
Tue   -1  sold in store        (Karim)
Tue   -2  sold on the website
Wed   -1  found damaged        (Mona)
Thu   +1  customer returned it
```

Current stock is that list added up: 17.

Nobody can reach in and set stock to "17". If a mistake is made, you add a
correcting line. This means every number in the system can be traced back to a
person, a time, and a reason — which is exactly what you cannot do with a
spreadsheet cell that someone overwrote in March.

For speed there is a second table holding the running total, but it is built
purely from that list, and a test checks every night that it still matches.

### Rule three: we tell Shopify the total, not the change

After any sale we do not tell Shopify "subtract one". We tell it "the number is
now 17".

This is a small difference with a big consequence: if a message gets lost or
sent twice, "subtract one" goes wrong, but "the number is 17" is still correct
the second time. Sending the same message twice does nothing. That property —
being safe to repeat — is what makes the whole sync reliable.

Shopify now requires this too. Since API version 2026-04, inventory updates
must carry an idempotency key, which is Shopify's own protection against the
same instruction being applied twice.

### The loop, and how we get out of it

Here is the trap that catches most people building this:

1. We tell Shopify the number is 17.
2. Shopify says "something changed! the number is 17!"
3. If we treated that as news, we would record a change...
4. ...which would make us tell Shopify again...
5. ...forever.

The way out is a rule that sounds strange but is the key to everything:

> **A message from Shopify never changes our stock. Ever.**

When Shopify tells us a quantity changed, we only *classify* it:

- **"That's our own echo."** We just sent that exact number, moments ago. We
  remember what we last told Shopify and when, so we recognise our own voice
  coming back. Ignore it.
- **"We already agree."** Usually this is a website order: Shopify reduced its
  own count when the customer checked out, and we recorded the same order a
  moment earlier. Nothing to do.
- **"We disagree."** Something we cannot explain. Write it down. Do not act.

That third case is where most systems go wrong by trying to be clever. We
deliberately do nothing, for a specific reason: **messages from Shopify do not
arrive in order.** An "inventory changed" message can easily arrive before the
"new order" message that explains it. A system that "fixed" the difference
immediately would be corrupting good data based on half the story.

### The nightly check

So instead, once a night — around 2am Cairo time, long after everything in
flight has landed — the system fetches every quantity from Shopify and compares
it to ours.

If they match, good. If they do not, it opens an item on the **Sync issues**
screen showing both numbers, and stops there.

**It never fixes anything by itself.** A difference can mean several very
different things:

- someone edited stock directly in the Shopify admin;
- a garment was damaged and thrown away without being recorded;
- an item was taken for a photoshoot and not put back;
- a message genuinely went missing.

Each of those wants a different answer, and only a person standing next to the
actual rail of clothes knows which one it is. So the screen offers three
buttons — *the CRM is right*, *Shopify is right*, *ignore this* — and whichever
you pick gets recorded with your name on it. Even "Shopify is right" does not
edit history: it adds a correcting line to the list, so next year you can still
see that on this date someone decided Shopify was correct, and why.

### Two paths to Shopify, so one can fail

When stock changes, two things happen:

- **Immediately:** the till pushes the new number to Shopify. Usually the
  website is updated within a second.
- **In the background:** the change is also added to a queue, and a job checks
  that queue every minute.

The immediate push is the one you notice. The queue is the one that saves you —
when the wifi drops mid-sale, when someone closes the tab, when Shopify is
briefly rate-limiting us. The sale is already safely recorded either way, and
the website catches up within the minute.

### Which Shopify number we write

Shopify tracks several quantities. Two can be written by an app: `on_hand`
(physically in the building) and `available` (free to sell right now). The
difference between them is `committed` — units promised to orders that have not
shipped yet — and Shopify manages that one itself.

**We write `available`.** This was not obvious, and the alternative breaks.

If we wrote `on_hand`, website orders would double-count. A customer orders
one; Shopify moves a unit from available to committed, leaving `on_hand` at 10.
We record the order too, so our count drops to 9, and we push `on_hand = 9`.
Shopify then computes available as 9 minus the 1 still committed — 8. We have
destroyed a unit that is sitting right there on the shelf.

Writing `available` lines up instead. The order drops Shopify's available to 9
on its own; our number is also 9; our push changes nothing. And when we make a
shop sale, setting available to 8 causes Shopify to lower `on_hand` by the same
unit, so that stays correct too.

The thing to know: **the CRM's number means "units free to sell", not "units in
the building".** Today those are the same. Once Phase 3 brings website orders
in, unshipped orders will sit between them, and the stock screen will show both
columns.

*Changing this later:* the `shopify_inventory_state` row in the `settings`
table switches between `available` and `on_hand` without a deploy. Read this
section again before you touch it.

---

## 2. One `orders` table, not separate sales and orders

A shop sale, a website order, an Instagram DM order and a wholesale order all
live in `orders`, told apart by a `channel` column. A shop sale is just an
order that was paid and handed over at the moment it was created.

The alternative — a `sales` table now and an `orders` table in Phase 3 — costs
a painful migration later and turns "show me everything this customer has ever
bought" into a union query forever after.

Line items copy the SKU, title and price at the moment of sale rather than
joining to the product. Prices and product names change; a receipt reprinted
six months from now must still show what was actually sold.

### The channel decides how an order starts

One screen takes every kind of order, and what it produces is not the same
thing each time. A shop sale is handed over as it is rung up, so it is born
delivered. An order taken over Instagram has to be confirmed by phone,
packed and shipped, so it starts at the front of the packing queue exactly
like one from the website.

Before this, both were recorded as counter sales. An order sitting in a box
in the back room claimed it had been handed to a customer, and money nobody
had counted claimed it had arrived.

### Two ways an order becomes paid, and only two

The rule was one: reviewing the courier settlement that contained it. That
exists so cash collected at somebody's front door is only recognised once it
has actually been counted against the courier's paper, and it has not moved
— `mark_order_paid` refuses a cash-on-delivery order outright, and a test
pins that refusal.

What it did not cover is money that never went near a courier. A regular
takes a hoodie and pays on Thursday; a transfer lands the next morning.
Those were being recorded as paid immediately, because there was nowhere
else to put them. Now they are a tab: the goods leave, the money is owed,
and someone settles it from the orders screen with their name against the
change.

So: the courier's cash is settled by reviewing a statement, and everything
else is settled by a person saying so. Both are recorded. Neither can be
done by editing a row.

---

## 3. Two cashiers, one hoodie

If two people sell the last item at the same instant, one of them must be told
no. Without care both would read "1 in stock", both would write their sale, and
you would owe a customer a hoodie that does not exist.

The running-total table is what prevents this. Recording a sale updates that
row, and updating a row in Postgres locks it. The second cashier's request
waits — for milliseconds — until the first finishes, then sees the real
remaining count and is refused.

This is verified by an actual two-connection test, not just reasoned about.

---

## 4. Some stock changes may go negative, and some may not

Refusing a sale and refusing a *record* of a sale are different things.

- **Shop sales and wholesale are refused** when there is not enough stock. We
  are the gatekeeper; we should not promise what we cannot supply.
- **Website orders, returns and cancellations are always recorded**, even if
  the result goes negative. That order already happened on the storefront.
  Refusing to write it down would not un-sell it — it would just mean the
  ledger is now wrong *and* we cannot see why.

A negative number is visible and gets picked up as a sync issue. A missing
record is invisible forever.

---

## 5. Roles are enforced by the database

Every permission rule lives in Postgres Row Level Security, not in the
interface. Hiding a button stops an honest mistake; it does not stop a crafted
request from a browser console.

The pattern throughout: hiding things in the UI is a courtesy, and every rule
it implies is independently enforced by a policy or a guard clause in a
database function. If you ever find a rule that exists only in the React code,
that is a bug in the database.

Two consequences worth knowing:

- **Unit cost lives in its own table** (`variant_costs`) rather than as a
  column on `variants`. Row Level Security filters rows, not columns — and
  sales staff need to read variants to ring up a sale. A separate table can
  have its own policy, so "sales staff cannot see the factory's margin" is
  enforced rather than merely unrendered.
- **The role is read from the database, not from the login token.** A token is
  valid for an hour after it is issued, so a token-based check would keep
  letting someone sell stock for up to an hour after you deactivated them.
  Reading the table costs one indexed lookup per query and makes deactivation
  take effect on their very next click.

---

## 6. The helper is called `has_any_role`, not `has_role`

pgTAP — the testing extension Supabase installs — defines its own
`public.has_role(name)` returning `text`. A function of ours with the same name
gets silently shadowed in some calls, and a security policy quietly receives
text where it expected true or false.

This was found by a test failing, not by reading the code. The name stays
deliberately different.

---

## 7. Everything that can be retried, can be retried safely

Three separate mechanisms, all solving the same class of problem:

- **The sale screen** generates a key when it opens. If the cashier taps
  *Complete sale* twice because the phone hesitated, the second request returns
  the first sale rather than selling the stock again.
- **Webhooks** are stored under Shopify's delivery id. A redelivery is
  recognised and acknowledged without being acted on twice.
- **Inventory pushes** carry the idempotency key Shopify now requires, so a
  retry after a timeout cannot apply the same change twice.

---

## 8. What is deliberately not built yet

- **Reserving stock for unshipped orders.** Needs Phase 3's order pipeline.
  Until then the CRM's number is both "free to sell" and "in the building".
- **Multiple locations.** The schema carries `location_id` on every ledger row
  from the start, and the UI uses the default location. Adding a second
  location is a UI change, not a migration — which is the whole reason the
  column is there this early.
- **Realtime stock updates in the browser.** Supabase supports it; it is left
  until Phase 5 so it arrives with staff chat rather than as a half-wired
  feature.
- **Accurate Logistics.** No endpoints have been guessed. Nothing will be
  written until their API documentation is provided.
