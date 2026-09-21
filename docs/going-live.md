# The trial, and going live

The CRM is deployed but deliberately not driving anything yet. Staff are
trying it, giving feedback, and the flow is still being changed. This is the
list of what is switched off for that, and what has to happen in what order
when it stops being a trial.

---

## What is off, and why

**Outbound inventory pushes are off.** `settings.shopify_push_enabled` is
`false`.

This is the one that matters. With it on, a staff member ringing up a
pretend sale on the trial app changes the real quantity on duch.store. Sell
the last black hoodie as a test and it disappears from the storefront;
record a return and a garment you do not have goes on sale. The people
trialling the app would be editing the live shop by using it, which is not
something you would notice until a customer did.

Turning it off is one row:

```sql
update public.settings set value = 'false'::jsonb where key = 'shopify_push_enabled';
```

Both push paths honour it — the immediate one from the till and the Worker's
queue drain — so there is no second switch to remember.

**The Worker is not deployed.** Two reasons. Its queue drain has nothing to
do while pushes are off. And its nightly reconciliation does *not* check the
push switch: it would compare the CRM's trial stock against the real Shopify
quantities and open a sync issue for every one of the 402 variants, every
night, burying the Sync issues screen under noise before anyone has used it.

**Opening stock has not been imported.** See below — this is the step that is
hard to undo.

---

## Stock during the trial

Staff need something to sell, and they can add it themselves through the
Stock screen. That is safe now: with pushes off, nothing they do reaches
Shopify. It also exercises the part of the app you most want feedback on.

Treat every number in the CRM during the trial as fiction. It will be thrown
away.

---

## Why opening stock waits

`import_opening_stock` writes an `initial_import` movement bringing each
variant up to what Shopify currently reports. It refuses to run for a variant
that already has movements, so that a second run cannot double your stock.

That refusal is the problem. Once staff have trialled the app, most variants
have a movement, and the import will decline to set an opening balance for
them — the safety catch that protects a real go-live also blocks it after a
trial.

So the trial's ledger has to be cleared before the real opening count. Which
is fine, because it was fiction anyway.

---

## Going live, in order

**1. Agree the app is finished changing.** Everything below assumes no more
flow changes, because step 3 is a hand count and you do not want to do it
twice.

**2. Clear the trial data.** Destructive and irreversible — take a backup
from the Supabase dashboard first.

`DELETE` will not work on the ledger, and that is not a bug:

```
ERROR: stock_movements is append-only; DELETE is not permitted.
       Append a correcting movement instead.
```

A `before delete` trigger enforces the rule from DECISIONS.md #1. `TRUNCATE`
is the deliberate way past it — row-level delete triggers do not fire on a
truncate — and needing a different verb to erase history is the right amount
of friction for something that should happen exactly once.

Because the guard is bypassed, so is the trigger that maintains
`stock_levels`. It does **not** empty itself, and has to be truncated in the
same statement or it keeps quantities for movements that no longer exist.

One statement, so foreign keys resolve together:

```sql
truncate
  public.stock_movements,
  public.stock_levels,
  public.order_line_items,
  public.order_events,
  public.return_lines,
  public.returns,
  public.settlement_lines,
  public.courier_settlements,
  public.shipments,
  public.orders,
  public.sync_outbox,
  public.sync_issues,
  public.shopify_inventory_pushes,
  public.webhook_events;
```

Then check nothing survived:

```sql
select
  (select count(*) from public.stock_movements) as movements,
  (select count(*) from public.stock_levels)    as levels,
  (select count(*) from public.orders)          as orders;
```

Leave `products`, `variants`, `staff` and `locations` alone — those are real.

`customers` is a judgement call. Trial rows are invented, and phone numbers
are uniquely indexed, so a made-up customer holding a real phone number will
collide with that person later. The orders referencing them are gone by this
point, so removing the invented ones is safe:

```sql
delete from public.customers where phone like '0100000%';  -- whatever the trial used
```

**3. Count the shop by hand.** Every variant. This number becomes the opening
balance and every future number is built on it. It is the one step worth
doing slowly, and the one nobody wants to repeat.

**4. Make Shopify match the count.** The opening import takes its numbers
from Shopify, so correct Shopify first, where it disagrees with the count.

**5. Import the opening stock.**

```bash
curl.exe -s -X POST "$SUPABASE_URL/functions/v1/shopify-import-products" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d "{\"import_opening_stock\": true, \"location_id\": \"<the CRM location uuid>\"}"
```

**6. Check a handful against the shop floor** before trusting the rest.

**7. Turn pushes on.**

```sql
update public.settings set value = 'true'::jsonb where key = 'shopify_push_enabled';
```

**8. Deploy the Worker**, which starts the queue drain and the nightly
reconciliation.

```bash
cd apps/worker
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

**9. Watch the first night.** The morning after, the Sync issues screen
should be empty or close to it. A screen full of mismatches means the
location id is wrong — see shopify-app-setup.md.

---

## Things that are safe to do during the trial

- Registering the webhooks. A webhook never changes stock; it is recorded and
  classified, and only the nightly job acts on a divergence — and that is not
  running.
- Importing the catalogue again, whenever products change in Shopify.
- Adding staff and setting their roles.
- Changing prices, titles and barcodes.
