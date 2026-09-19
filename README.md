# Duch CRM

Internal operations system for Duch. Replaces writing every in-store sale into
a paper log, a spreadsheet and Shopify with a single action.

The CRM database is the single source of truth for stock; Shopify mirrors it.
Read [DECISIONS.md](DECISIONS.md#1-how-stock-stays-in-sync-with-shopify) before
changing anything to do with inventory — the sync design has some deliberate
choices that look wrong until you know why.

**Status: Phases 1 and 2 complete. Phase 3 schema built and tested.** Staff accounts and roles, the Shopify
product import, the stock ledger, the in-store sale screen, inventory sync with
loop prevention, and nightly reconciliation.

Phase 3 so far: website orders import from Shopify, the order lifecycle with
custody tracking, returns with per-item check-in, exchanges, and courier
settlements. Its screens are not built yet — see
[docs/phase-3-orders-and-returns.md](docs/phase-3-orders-and-returns.md).

---

## Start here

Nothing is deployed yet. **[docs/getting-started.md](docs/getting-started.md)**
is the whole path from an empty machine to a working CRM, in order. Part A gets
it running locally with test data in about half an hour, without touching
Shopify or your live database.

---

## What you need installed

| Tool | Version | Why |
|---|---|---|
| Node.js | 20 or newer | Building the dashboard, running tests |
| Supabase CLI | latest | Migrations, local database, Edge Functions |
| Docker Desktop | running | The Supabase CLI runs Postgres in it |
| Git | any | Version control |

```bash
node --version && supabase --version && docker version
```

If Node is missing, install the LTS build from <https://nodejs.org>. The
Supabase CLI install instructions are at
<https://supabase.com/docs/guides/local-development/cli/getting-started>.

---

## Getting it running locally

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
supabase start
```

That prints a local API URL and an anon key. Put them in `.env` as
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

```bash
npm run db:reset
```

This applies every migration and loads `supabase/seed.sql`, which creates four
test logins — all with the password `duch-dev-password`:

| Email | Role | Can do |
|---|---|---|
| `admin@duch.local` | admin | everything |
| `stock@duch.local` | stock_manager | stock, adjustments, costs, sync issues |
| `sales@duch.local` | sales | ring up sales, read stock |
| `packing@duch.local` | packing | read only |

```bash
npm run dev
```

The dashboard is at <http://localhost:5173>. It is also served on your local
network address, so you can open it on a phone and try the sale screen the way
staff will actually use it.

---

## Running the tests

```bash
npm run db:test
```

Runs the pgTAP suites in `supabase/tests` — 118 assertions covering the stock
ledger, the in-store sale, role enforcement, the Shopify sync logic, the order
lifecycle with custody and returns, courier settlements, and order import.

```bash
npm test
```

Runs the TypeScript suites in `tests/` — webhook signature verification and
money arithmetic.

```bash
npm run functions:check
```

Type-checks the Edge Functions. Needs [Deno](https://deno.com) installed
(`scoop install deno`) — the dashboard's TypeScript config does not cover
`supabase/functions`, so without this they are never compiled at all.

There is also a test that cannot be written as a single-session SQL script,
because it needs two database connections at once:

```bash
bash scripts/test-concurrency.sh
```

It puts one unit in stock and has two cashiers try to sell it simultaneously.
One sale must succeed, the other must be refused, and stock must end at zero.

---

## Connecting it to Shopify

Follow [docs/shopify-app-setup.md](docs/shopify-app-setup.md). It covers
creating the custom app, the access scopes needed, finding your location ID,
and registering the webhooks.

Once the secrets are set:

```bash
supabase functions deploy shopify-webhook shopify-import-products push-inventory reconcile-stock
```

Then import the catalogue — from the **Products** screen, or directly:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/shopify-import-products" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d '{"dry_run":true}'
```

Start with `dry_run: true` to see what it would write. To also bring in current
stock as an opening balance, pass `import_opening_stock` with the CRM location
id. That is a one-time action — it refuses to run twice for a variant that
already has ledger history, because doing so would double everyone's stock.

---

## One-time setup in the Supabase dashboard

**Enable the access token hook.** Authentication → Hooks → Customize Access
Token (JWT) Claims → select `public.custom_access_token_hook`.

This puts the signed-in person's role into their token so the sidebar renders
without an extra request. It is a convenience only — every security decision
reads the `staff` table, so the app is correct without it, just marginally
slower.

**Create the first admin.** Sign up through the app, then promote yourself.
New accounts are deliberately created inactive with no usable role, so nobody
can see anything until an admin approves them:

```sql
update public.staff set role = 'admin', is_active = true where id = (select id from auth.users where email = 'you@duch.store');
```

---

## Deploying

**Database.** `supabase db push` applies migrations to the linked project.
Never change the schema by hand in the dashboard — a manual change is invisible
to everyone else and will be silently reverted by the next migration.

**Dashboard.** Cloudflare Pages. Build command `npm run build`, output
directory `apps/dashboard/dist`, and set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` as environment variables.

**Edge Functions.** Secrets first, then deploy:

```bash
supabase secrets set SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_API_TOKEN=... SHOPIFY_WEBHOOK_SECRET=... SHOPIFY_LOCATION_ID=... SHOPIFY_API_VERSION=2026-07
```

**Scheduled jobs.** The Cloudflare Worker in `apps/worker` drains the inventory
outbox every minute and runs reconciliation nightly:

```bash
cd apps/worker && npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY && npx wrangler deploy
```

---

## Which key goes where

Getting this wrong is the one mistake with real consequences.

| Key | Where it belongs | What it does |
|---|---|---|
| `VITE_SUPABASE_ANON_KEY` | the dashboard, the browser | Public by design. Row Level Security is what protects the data. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions and the Worker only | **Bypasses all security policies.** Never in any `VITE_` variable, never in the dashboard, never in a commit. |

If the service role key ever reaches the browser bundle, rotate it in the
Supabase dashboard immediately.

---

## Layout

```
apps/dashboard      React + Vite + Refine + Tailwind. Arabic and English.
apps/worker         Cloudflare Worker. Cron triggers only.
packages/shared     Types, enums and money maths used by all three.
supabase/
  migrations/       Every schema change, in order. The only way to change it.
  functions/        Edge Functions: webhooks, import, push, reconcile.
  tests/            pgTAP suites.
  seed.sql          Local development data.
tests/              TypeScript tests.
docs/               Shopify setup; Accurate integration notes.
```

## Where things are decided

- Stock sync, and why it works the way it does — [DECISIONS.md](DECISIONS.md)
- Stock ledger schema — `supabase/migrations/20260917090300_stock_ledger.sql`
- Sale logic — `supabase/migrations/20260917090400_customers_orders.sql`
- Echo detection — `supabase/migrations/20260917090500_shopify_sync.sql`
- Permissions — `supabase/migrations/20260917090600_rls_policies.sql`
