# Handoff

Everything a fresh session needs to pick this up. Read this first, then
[DECISIONS.md](DECISIONS.md) before touching anything to do with stock or
money.

---

## What this is

An internal CRM for **Duch**, a streetwear brand run out of a family clothing
factory in Egypt. It replaces writing every sale into a paper log, a
spreadsheet and Shopify with one action.

Channels: Shopify storefront (duch.store, EGP), Instagram/WhatsApp DMs, a
physical shop, and wholesale. Courier is **Accurate Logistics**. Around ten
staff. Interface is Arabic-first with English, right-to-left from the start.

**The CRM database owns stock. Shopify mirrors it.** That single rule drives
most of the design.

---

## State of play

**Built and tested:** Phases 1, 2 and 3 complete.

- 29 migrations, 11 pgTAP suites, **218 database assertions**
- **65 TypeScript assertions** (webhook HMAC, money arithmetic, invoice
  totals, Shopify token exchange, Cairo dates)
- 12 screens, 4 Edge Functions, 1 Cloudflare Worker
- 44 commits, working tree clean

**Not built:** wholesale (Phase 4), staff chat and analytics (Phase 5), Meta
inbox (Phase 6).

### Deployment: half live

Supabase project `yyzrhizisdjpwcnnqiwr` (eu-west-1) is real and working.

| | |
|---|---|
| Schema | All 29 migrations pushed. The seed is **not** pushed, deliberately. |
| Edge Functions | All four deployed. |
| Shopify | Dev Dashboard app connected. Catalogue imported: 47 products, 402 variants, 402 distinct SKUs. |
| Location | `النزهه`, default, linked to Shopify location `90745733441`. |
| Stock | **None.** No movements, no opening balance. |
| Pushes to Shopify | **Off.** See below. |
| Dashboard | Live at **https://duch-crm.yassentah.workers.dev** - a Workers project (not Pages), built from GitHub on every push to `master`. |
| Worker (cron) | **Not deployed**, on purpose. |
| Webhooks | Not registered. |
| Staff | Six accounts, all admin for the trial. |

**It is a trial, not a launch.** Staff are going to try the app and give
feedback before anything real runs on it, so `shopify_push_enabled` is
`false` — otherwise a test sale would change what duch.store actually sells.
The Worker is undeployed and opening stock unimported for related reasons.
**Read [docs/going-live.md](docs/going-live.md) before turning any of that
on**; the order matters and the trial ledger has to be cleared first.

**Left to do:** register the webhooks. 21 variants are priced at zero
(puffer jackets and crewneck sweaters still in production — the user adds
prices when they are ready, so this is not a fault).

**No staff screen exists.** Accounts are created in the Supabase dashboard
and roles are set in SQL — see getting-started B4. This is the first thing
to build if the trial turns into daily use.

**Six reporting views still have no screen**: return cohorts, stock
valuation, courier custody, custody exceptions, unsettled orders, return
check-in summary. They are built and tested. Reports covers daily sales, the
activity log, refusal costs and customer reliability.

**Blocked:** the Accurate Logistics integration, waiting on their API docs.
See [docs/accurate-integration.md](docs/accurate-integration.md) for the eight
questions their docs need to answer. Do not guess their endpoints.

---

## Running it

Node and the Supabase CLI are installed but **are not on this agent's PATH**
(the shell started before they were installed). Prepend them:

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:USERPROFILE\scoop\shims;$env:PATH"
```

Docker Desktop must be running — the Supabase stack lives in it. It sometimes
needs starting by hand and can take a few minutes; its Windows service cannot
be started without elevation, so if it will not come up, ask the user.

| Command | What it does |
|---|---|
| `supabase start` | Local Postgres, auth, storage |
| `npm run db:reset` | Reapply every migration and the seed |
| `npm run db:test` | 218 pgTAP assertions |
| `npm test` | 65 vitest assertions |
| `npm run typecheck` | All three workspaces |
| `npm run build` | What Cloudflare runs. Uses `.env.production`, so it points at the **real** project even locally. `npm run dev` still uses `.env`. |
| `npm run dev` | Dashboard on :5173, also on the LAN |
| `bash scripts/test-concurrency.sh` | Two-connection race test |

Deno is not installed locally, so `npm run functions:check` needs Docker:

```bash
docker run --rm -v "C:\Users\yasse\Projects\duch-crm\supabase\functions:/fn:ro" denoland/deno:latest sh -c "cp -r /fn/* /tmp && cd /tmp && deno check shopify-webhook/index.ts"
```

**`psql` is not installed on this machine** and the Supabase CLI does not ship
it, so anything calling `psql` directly fails with `command not found`.
`scripts/test-concurrency.sh` detects this and uses the client inside the
`supabase_db_duch-crm` container instead, so it runs as listed above with no
setup. Point `DATABASE_URL` at a non-local database and it refuses rather than
racing the wrong one. For one-off queries, the same trick works by hand:

```bash
docker exec -i supabase_db_duch-crm psql postgresql://postgres:postgres@127.0.0.1:5432/postgres -c "select 1;"
```

**Seed logins** — password `duch-dev-password` for all:
`admin@duch.local`, `stock@duch.local`, `sales@duch.local`, `packing@duch.local`.

**On a phone:** `http://192.168.1.6:5173` — the address changes with DHCP, and
`http://` must be typed in full because phone browsers silently upgrade to
https and the dev server has no certificate.

---

## Working agreements with this user

- **Check the live docs.** Shopify and Supabase APIs change; do not answer from
  memory. Shopify Admin API is pinned to **2026-07**.
- **Every schema change is a migration.** Never edit the database by hand.
- **Never commit secrets.** The service role key bypasses all security and
  belongs only in Edge Functions and the Worker, never in a `VITE_` variable.
- **Verify by running, not by reading.** Nearly every real bug in this project
  was found by executing something — the tests, the app in a browser, the
  toolchain. Several were found only by driving the UI as a specific role.
- Tell the user plainly when something is unverified.

---

## Traps already hit — do not rediscover these

**pgTAP defines `public.has_role(name)` returning `text`.** Our helper is
`has_any_role` for exactly that reason. Never name a function `has_role`.

**A `CASE` returning string literals into an enum column needs an explicit
cast.** This has bitten three times. Write `… end::public.some_enum`.

**`revoke execute … from authenticated` does nothing on its own** — Postgres
grants EXECUTE to `PUBLIC` by default. Always `revoke … from public, anon,
authenticated`.

**`supabase test db` runs against the seeded database.** Test fixtures must not
collide with seed rows (phone numbers are uniquely indexed; only one location
may be default), and assertions must be scoped to their own fixtures. An
assertion that sums across the whole database passes only while the database
is empty.

**Vite's `envDir` points at the repo root** so there is one `.env`, and Vite
**proxies Supabase at `/supabase`** so a phone needs one reachable port rather
than two. In development the client talks to its own origin.

**`navigator.clipboard` does not exist on a non-secure origin**, which
includes the LAN address the user opens on their phone. Anything copying to
the clipboard needs the `execCommand` fallback used in `AccountantSummary`.

**Modals must cap their height and scroll.** A tall form otherwise puts the
confirm button below the fold with no way to reach it.

**Seeded `auth.users` rows need empty-string token columns** (`confirmation_token`
and friends), or every sign-in fails with "Database error querying schema",
which the UI reports as a wrong password.

**In PowerShell, `curl` is not curl.** It is an alias for
`Invoke-WebRequest`, which rejects repeated `-d` flags with a parameter
binding error that says nothing about the real problem. Every command handed
to this user needs `curl.exe`, or PowerShell-native syntax. This cost time
twice in one session.

**Shopify retired admin-created custom apps.** There is no permanent `shpat_`
token to copy any more; a Dev Dashboard app holds a client id and secret, and
the token exchanged from them expires after 24 hours. `_shared/shopify-token.ts`
handles it. See [docs/shopify-app-setup.md](docs/shopify-app-setup.md).

**A Shopify client id is 32 hex characters.** Half a deployment session went
into an `application_cannot_be_found` that turned out to be a 14-character
value in `SHOPIFY_CLIENT_ID`. The functions now report the *shape* of the
credentials they were given — length, stray quotes, surrounding whitespace —
without revealing them. Read that before checking anything in the Shopify
admin.

**Staff are deactivated, never deleted.** `stock_movements` and
`order_events` reference `staff` with `on delete restrict`, because they are
append-only and a ledger that forgets who did something is not much of a
ledger. Before that was fixed, deleting a staff member failed with
"stock_movements is append-only; UPDATE is not permitted", which says
nothing about staff.

**Settlements count goods, never shipping.** Accurate keeps the shipping fee
the customer pays at the door, so it never reaches the transfer. A delivered
line carries no courier fee; a refusal does, because nobody paid for that
delivery.

**`DELETE` on `stock_movements` is refused by a trigger.** That is
deliberate. `TRUNCATE` is the way past it for the one legitimate case, and
because that also bypasses the trigger maintaining `stock_levels`, that table
must be truncated in the same statement. See
[docs/going-live.md](docs/going-live.md).

**Latin text inside a right-to-left block gets reordered.** An address stored
as "8 Abbas El Akkad, Nasr City" renders with the house number at the far end
of the line, and a numeric date renders back to front — 19/09/2026 becomes
2026/09/19, which a reader can act on wrongly. Wrap anything that might be in
either language in `<bdi>`, which isolates the run without dragging it to the
other margin the way `dir="auto"` does. `Intl`'s Arabic date formats embed
right-to-left marks that survive even that, so `Invoice.tsx` strips them.
Found by printing an invoice and looking at it.

---

## The design decisions that look wrong until explained

Full reasoning is in [DECISIONS.md](DECISIONS.md). The short version:

**Stock is an append-only ledger.** `stock_movements` is never updated or
deleted; mistakes are corrected by appending the opposite movement.
`stock_levels` is a trigger-maintained running total whose row lock is what
stops two cashiers selling the same last item. Proven by a two-connection test.

**We mirror Shopify's `available`, not `on_hand`.** Writing `on_hand`
double-counts website orders and destroys a unit per sale.

**A webhook from Shopify never changes stock.** It is classified as echo,
agreement or divergence and recorded. Only the nightly job opens a sync issue,
and only a person resolves one — because Shopify's webhooks do not arrive in
order.

**An order can be edited, but only while its money is still open.** Paid, or
on a courier statement, and everything except the note is refused - those
figures have been counted. Changing the basket appends a correcting
`adjustment` movement rather than rewriting the original sale.

**Orders have two statuses.** `fulfillment_status` (where the goods are) and
`payment_status` (where the money is). With cash on delivery they move on
completely separate timelines.

**Cash the courier collected becomes `paid` in exactly one place:** when the
settlement containing it is reviewed. `mark_order_paid` refuses a
cash-on-delivery order outright, so that rule cannot be worked around from
the orders screen. Money that never went near a courier — a tab, a transfer
that landed late — is settled there instead, and the change is recorded with
a name against it.

**Nothing moves stock while goods are in a van.** Returns are recorded when
the parcel is physically checked in, per item with a count. A parcel that
arrives short stays open as a discrepancy. This is the user's anti-theft
control and he cares about it.

**Failed deliveries and post-delivery returns are separate.** A refusal at the
door and a size exchange have different causes and different fixes.

---

## How this business actually works

Recorded from the user; most of the design follows from it. Fuller version in
[docs/phase-3-orders-and-returns.md](docs/phase-3-orders-and-returns.md).

- A pickup car comes **every day**, taking parcels out and bringing returns
  back **batched** from the courier's station.
- **Every order is phoned to confirm before it ships**, cash on delivery or not.
- **Refusals are above average.** The two dominant reasons are the customer
  not answering, and the customer opening the parcel at the door and declining.
- A refusal costs a **full shipping fee**; a non-response costs a small one. So
  the expensive failure is the opened-and-refused one, which is a
  product-expectation problem rather than a delivery one.
- Delivery takes three to five days; a refusal comes back within two or three.
  A shipping cohort is treated as final after **14 days**.
- An opened-and-refused garment just needs **repackaging** — it goes back into
  sellable stock.
- The courier's statement **cannot be exported and has no API**. It is typed in
  by hand with their paper alongside.
- The customer pays shipping on top, and it sits inside the amount the courier
  collects.
- **The accountant keeps a paper ledger.** What he needs is products and
  prices — "this transfer was three hoodies at 1,450 and two cargos at 1,850"
  — not order numbers. Today the user types that into WhatsApp by hand.

---

## Where things live

```
apps/dashboard      React 19 + Vite + Refine (headless) + Tailwind v4
apps/worker         Cloudflare Worker, cron only
packages/shared     Enums, money maths, date formatting
supabase/migrations Every schema change, in order
supabase/functions  shopify-webhook, shopify-import-products,
                    push-inventory, reconcile-stock
supabase/tests      pgTAP suites
tests/              vitest
docs/               getting-started, shopify-app-setup,
                    phase-3-orders-and-returns, accurate-integration
```

---

## Open questions for the user

1. Does the accountant message wording actually suit his ledger? He has not
   reviewed one yet.
2. Phone feel of the confirmation-call step in the packing queue, and of
   counting a pile of returns at check-in. He has the app on his phone.
3. Damaged returns — currently recorded on the line but with no countable
   damaged-stock bucket. He said "just repackaging, that's it", so this may
   never be needed.
4. The invoice's seller details are unanswered and stored empty: registered
   address, tax number, commercial register. They live in the
   `business_identity` row of `settings`, so filling them in is an admin edit
   rather than a deploy, and empty ones print nothing. Also unconfirmed:
   whether wholesale wants different wording from a DM order.

---

## What to do next

In rough priority order. Ask the user rather than assuming.

1. **Finish the deployment.** Push to GitHub, connect Cloudflare Pages,
   register the webhooks, make the first admin. Then staff can trial it on
   their phones, which is the point.
2. **Run the trial**, collect feedback, change the flow. Expect this to take
   a while and to produce most of the remaining work.
3. **Go live** — [docs/going-live.md](docs/going-live.md), in order.
4. **Accurate integration** — the moment their docs arrive. Replaces manual
   tracking-code entry and drives every status from `in_transit` onwards.
5. **Wholesale**, then **staff chat and analytics**, then the **Meta inbox**.

The local database was reset on 2026-09-20, so the old demo orders are gone.
What is there now is the standard seed plus whatever the race test last left
behind (a `RACE-TEST-HOOD` variant). `npm run db:reset` clears it. None of
this touches the production project, which has no stock at all.
