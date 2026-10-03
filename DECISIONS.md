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

The same check can be run on demand with **Check with Shopify now** on that
screen, and a product whose sizes all differ can be answered in one go
(**Resolve all**). Both were added on day three of go-live, when slipper stock
edited in the Shopify admin had to wait for midnight and then be answered one
size at a time, while each sale in between pushed the CRM's old number back
over the edit. Neither changes the rule: a person still decides, and each size
still gets its own correcting line with their name on it. The numbers used are
the ones from the last check, which the screen shows, so check again if
Shopify was changed since.

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
delivered. An order taken over Instagram still has to be shipped, so it
starts in the packing queue exactly like one from the website.

**Shipping is one step (2026-10-01).** The queue used to walk each order
through a confirmation call, packed, shipment created and handed to the
courier - four taps, all made in a row at the moment the parcel left. The
owner asked for one: the courier's shipment number, one tap, and the order is
in transit with the handover time recorded (`ship_order`). The call is still
there to log, and is the in-app way to cancel a DM order, but nothing waits
on it. The shipment number is still required - that rule is the one that
lets a missing parcel be chased.

Before this, both were recorded as counter sales. An order sitting in a box
in the back room claimed it had been handed to a customer, and money nobody
had counted claimed it had arrived.

### How an order becomes paid

**Current rule (2026-09-28, the owner's decision): any unpaid order except a
card sale can be marked paid by hand from the orders screen, cash on
delivery included.** The history below is why it used to be stricter. The
owner weighed the control it gave - courier cash only counted once checked
against Accurate's statement - against orders the rule could not reach, and
chose the button. Every change still records who made it, and the settlement
review only pays orders that are still unpaid, so an order already marked
paid by hand is skipped rather than counted twice. The settlement screen
remains the way to check Accurate's money against the orders.

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

**A third door, for our own drivers.** Not every parcel goes with Accurate;
sometimes one of the company's workers delivers it and brings the cash back.
No statement will ever cover that money, so the settlement route cannot
settle it. It is two steps, mirroring the courier custody control:
`start_own_delivery` sends a waiting order out with a named driver (or one
waiting for Accurate that the courier has not collected - its Accurate
shipment is cancelled), and the
packing queue shows it under "with our driver" - who is holding whose cash,
and for how long. `complete_own_delivery` records it delivered and, for cash
on delivery, paid, once the driver hands the money in. It opens only for an
order that is out with our own driver, and only for the people who can
already settle a tab. A paying-later order delivered this way stays unpaid:
the customer still owes it.

**A returned order is closed (2026-10-03).** Once the goods are back, or on
their way back, nothing is owed: Mark paid is refused, the Orders screen
shows "nothing owed" and leaves it out of the owed total, and its money and
items cannot be edited (editing the basket would move stock the return
already put back). The payment status is deliberately left unpaid rather than
given a new value, because a returned courier parcel is still expected on
Accurate's statement with a return fee, and the awaiting-settlement list
finds it by being unpaid. Found on S2609-00015, marked paid after it came
back.

**Undoing a mistake: the owner only.** A paid order's money is locked, which
also means a till mistake - "cash" picked for an order nobody has paid - has
no way back. `reopen_order_payment` sets a paid order back to unpaid and
corrects its method, with a required reason written into the order's
history. It is the narrowest tool that fixes the mistake: after it, the order
is simply open again and the ordinary editor applies. Only the account marked
`is_owner` may use it. That is not a role - several people are admin - and it
cannot be set from the app by anyone, admins and the owner included; other
admins cannot demote or deactivate the owner either. An order on a courier
statement stays locked even for the owner, because that money was counted
against Accurate's paper.

Own deliveries are kept out of `v_courier_custody`. Mixing them in would put
our drivers into the courier's figures and its seven-to-ten-day overdue
thresholds, when an own delivery should be back the same day.

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

**Rules name permissions, not roles (2026-10-05).** The owner wanted roles
they name themselves, with exactly the permissions they tick. So a role is a
row in `public.roles` - a name and a list from `known_permissions()` - and
every policy and guard asks `has_permission('orders.ship')`, never "is this
person packing". The four original roles are built-in rows, fixed, whose
permissions reproduce what each could do before; the tests that exercised
them still pass unchanged, which is the proof. `staff.role_id` is what is
read; `staff.role` mirrors it for built-in roles and is null for a custom
one. Two rules keep this from becoming a way to promote yourself: nobody can
create, edit or give a role holding a permission they do not hold, and only
an admin can change an admin or give the admin role ("*", everything).

Cancelling is its own permission (`orders.cancel`) rather than part of
editing, because sales staff could edit an order but never cancel one, and
the built-in roles had to stay exactly as they were.

Two consequences worth knowing:

- **Unit cost lives in its own table** (`variant_costs`) rather than as a
  column on `variants`. Row Level Security filters rows, not columns — and
  sales staff need to read variants to ring up a sale. A separate table can
  have its own policy, so "sales staff cannot see the factory's margin" is
  enforced rather than merely unrendered.
- **Permissions are read from the database, not from the login token.** A token is
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

---

## 9. The staff screen manages roles, not logins

The staff screen lets someone with the staff permission activate a signup,
give it a role, and create or edit custom roles. It
deliberately does not let an admin create a new login from the app.

Creating one would mean giving an Edge Function the service role key's power
to call Supabase's Admin API and mint an `auth.users` row - a new
elevated-privilege surface, reachable from the browser, for a capability
this project already has a working, if manual, answer for: **Authentication
→ Users → Add user** in the Supabase dashboard. The signup trigger already
turns that into an inactive `staff` row with no further code, which is what
the screen actually needed to solve - see getting-started.md B4.

If this becomes real friction, the fix is a narrowly-scoped Edge Function
that checks the caller is an admin before calling `auth.admin.createUser`,
not a general-purpose one.

---

## 10. Arabic only, and what goes on paper

The owner's call on 2026-10-04: the CRM is Arabic only for now. The English
dictionary stays so it can come back, but `ARABIC_ONLY` in `i18n/index.tsx`
pins every browser to Arabic and the language button is gone. The brand is
"دش" in Arabic text; the DUCH wordmark stays on printed paper.

The database explains refusals in English, because tests and developers read
them. Staff never see that text directly: every message on screen goes
through `arabicError()` in `apps/dashboard/src/lib/errors.ts`, which
translates the ones we know (keeping the order number in them) and puts any
it does not know under an Arabic sentence. A new `raise exception` that staff
can hit should get a rule there.

The printouts carry only what the owner listed:

- **Invoice (الفاتورة):** customer name, phone and address; each product with
  quantity, price per piece and line total; discount and shipping when there
  are any; the total. No payment method, no paid stamp, and never the order
  note, which is written for staff.
- **Packing slip (البوليصة):** the products, quantity, price per piece and
  total, under the order number so the packer can match paper to box. The
  courier's label carries the customer and the amount to collect.

### "Owed" on the Orders screen

Owed means delivered and not paid: the customer has the goods and we do not
have the money. An order still waiting to ship has not been handed over, and
a parcel with the courier is the courier's to answer for - it shows under
"on the road", and goes late after seven days, the custody report's line.
Returned and cancelled orders are closed and never owed. The figure at the
top of the screen and the "owed" tab use this one definition.

