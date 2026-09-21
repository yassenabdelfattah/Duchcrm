# Getting started

Nothing is deployed yet. This is the whole path from an empty machine to a
working CRM, in the order it has to happen.

**Do Part A first.** It gets the CRM running on your own machine with fake data
in about half an hour, without touching Shopify or your real Supabase project.
You can click through the sale screen, try each staff role, and see whether the
thing is any good before wiring it to anything real.

---

## Part A — run it on your machine

### A1. Install the three tools

| Tool | Where | Check it worked |
|---|---|---|
| Node.js 20 or newer | <https://nodejs.org> — take the LTS installer | `node --version` |
| Docker Desktop | already installed — just make sure it is running | `docker version` |
| Supabase CLI | <https://supabase.com/docs/guides/local-development/cli/getting-started> | `supabase --version` |

On Windows the Supabase CLI installs most easily with Scoop:

```bash
scoop install supabase
```

Docker Desktop has to be **running**, not just installed — the Supabase CLI
starts Postgres inside it. If its whale icon is not in your system tray, open
it from the Start menu and wait for it to say "Engine running".

### A2. Install the project

**Change into the project folder first.** Every command from here on has to run
there — `npm` looks for the project in whatever folder you are standing in, and
a fresh terminal always starts in your home folder.

```bash
cd C:\Users\yasse\Projects\duch-crm
```

```bash
npm install
```

If you see `Could not read package.json ... C:\Users\yasse\package.json`, that
is this exact thing: you are in your home folder. Run the `cd` above and try
again.

npm may also warn that some packages "have install scripts not yet covered by
allowScripts". That is npm being cautious about running third-party install
scripts and is safe to ignore here — everything needed is already installed.

### A3. Start the local database

```bash
supabase start
```

The first run downloads several gigabytes of containers and can take ten or
fifteen minutes. It looks like it has hung; it has not. Later runs take
seconds.

When it finishes it prints a block of URLs and keys. **Keep that output** — you
need two lines from it in the next step. If you lose it:

```bash
supabase status
```

### A4. Point the app at it

```bash
cp .env.example .env
```

Open `.env` and set two values from what `supabase start` printed:

- `VITE_SUPABASE_URL` → the **API URL** (usually `http://127.0.0.1:54321`)
- `VITE_SUPABASE_ANON_KEY` → the **anon key**

Leave everything else alone for now.

### A5. Build the database

```bash
npm run db:reset
```

This applies every migration and loads test data: a shop, two products, six
variants with stock, and four staff logins.

### A6. Open it

```bash
npm run dev
```

Go to <http://localhost:5173>. Sign in with any of these — the password is
`duch-dev-password` for all four:

| Email | Role | What they can do |
|---|---|---|
| `admin@duch.local` | admin | everything |
| `stock@duch.local` | stock manager | stock, adjustments, costs, sync issues |
| `sales@duch.local` | sales | ring up sales, read stock |
| `packing@duch.local` | packing | read only |

Try signing in as `sales@duch.local` and then as `admin@duch.local` — the sales
user genuinely cannot see unit costs or sync issues, and that is enforced by
the database rather than by hiding menu items.

### Opening it on your phone

This matters more than it sounds. The sale screen and the packing queue are
built for someone holding a phone one-handed behind a counter, and that is not
something you can judge on a laptop.

When `npm run dev` starts it prints two addresses. Use the one labelled
**Network** — something like `http://192.168.1.6:5173`. Your phone has to be on
the same wifi.

The app rewrites its own API address to match whatever host you loaded it from,
so there is nothing to edit to make this work and nothing to redo when the
router hands out a different address tomorrow. Without that, the phone would
load the page and then fail every request, because the `127.0.0.1` in `.env`
means *the phone itself* once you are on the phone.

**"This site can't provide a secure connection."** This is the one almost
everybody hits, and it is not a network problem — it means the phone reached
the laptop, tried to speak HTTPS, and got plain HTTP back. The dev server has
no certificate, because it is a development server.

Type the address in full, including `http://`, and do not let autocomplete
finish it:

```
http://192.168.1.6:5173
```

If the browser still forces HTTPS, it has "always use secure connections"
switched on. In Chrome: **Settings → Privacy and security → Security →
Always use secure connections**, turn it off. Opening the address in a private
tab also works, since it skips whatever the browser has remembered.

None of this applies once the CRM is deployed — Cloudflare Pages serves real
HTTPS, and staff will just open duch's address like any other website.

If the page loads but nothing works, the usual causes are a firewall blocking
the port, or the router having client isolation switched on — common on guest
networks. Try the main network rather than the guest one.

### A7. Check it is all sound

```bash
npm run db:test
```

```bash
npm test
```

118 database assertions and 36 TypeScript ones. Everything should pass.

---

## Part B — connect your real Supabase project

Only once Part A works.

### B1. Link the project

Find your project reference in the Supabase dashboard URL:
`https://supabase.com/dashboard/project/<this-bit>`.

```bash
supabase link --project-ref your-project-ref
```

### B2. Push the schema

```bash
supabase db push
```

**Never change the schema by hand in the Supabase dashboard.** A manual change
is invisible to everyone else and the next migration will quietly undo it.
Every change goes in a migration file.

### B3. Turn on the access token hook

In the Supabase dashboard: **Authentication → Hooks → Customize Access Token
(JWT) Claims**, and choose `public.custom_access_token_hook`.

This lets the app know your role without an extra request. It is a convenience
only — every security decision reads the database directly, so the CRM is
correct without it, just marginally slower.

### B4. Make yourself the admin

Sign up through the app with your real email. New accounts are deliberately
created **inactive with no role**, so nobody can see anything until an admin
approves them — including you, the first time.

Then in the Supabase dashboard's SQL editor:

```sql
update public.staff set role = 'admin', is_active = true
 where id = (select id from auth.users where email = 'you@duch.store');
```

After that you can approve everyone else from inside the CRM.

### B5. Create your location

The local test data includes a shop, but **the seed is not pushed to your
real project** — `supabase db push` sends migrations only, which is correct:
you do not want fake products and `duch.local` logins in production. It does
mean a freshly pushed project has no location at all, and without one there
is nothing to sell from, nothing to hold stock, and nothing for Shopify to
link to.

Create it once, in the SQL editor, naming it whatever you call the shop:

```sql
insert into public.locations (name, type, is_default, is_active)
values ('النزهه', 'store', true, true);
```

Part C step 2 then links it to the matching Shopify location.

---

## Part C — connect Shopify

Full detail is in [shopify-app-setup.md](shopify-app-setup.md). The shape of it:

1. Create a custom app in Shopify admin with six scopes (`read_products`,
   `read_inventory`, `write_inventory`, `read_orders`, `read_customers`,
   `read_locations`).
2. Copy the Admin API token — **it is shown exactly once**.
3. Find your location ID and link it to the CRM location.
4. Set the secrets, deploy the functions, register the webhooks.
5. Import the catalogue with `dry_run` first, fix any variants missing a SKU,
   then run it for real.

### Count the shop by hand before importing opening stock

Whatever Shopify currently says becomes your opening balance, and every number
afterwards is built on it. This is the one step worth doing slowly.

---

## Part D — put it online

### D1. The dashboard, on Cloudflare Pages

Connect the repository, then:

- Build command: `npm run build`
- Output directory: `apps/dashboard/dist`
- Environment variables: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`,
  pointing at your real Supabase project this time.

### D2. The scheduled jobs, on Cloudflare Workers

```bash
cd apps/worker && npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

```bash
cd apps/worker && npx wrangler deploy
```

This drains the inventory queue every minute and runs the stock reconciliation
nightly.

---

## The one rule about keys

| Key | Where it belongs |
|---|---|
| **anon key** | The dashboard, the browser, Cloudflare Pages. Public by design — it ships inside the JavaScript and anyone can read it. Row Level Security is what protects the data. |
| **service role key** | Edge Functions and the Worker only. **It bypasses every security rule.** Never in a `VITE_` variable, never in the dashboard, never in a commit. |

If the service role key ever ends up in the browser bundle, rotate it in the
Supabase dashboard immediately.

---

## If something goes wrong

**`supabase start` hangs or fails.** Docker Desktop is not running, or is still
starting. Wait for "Engine running" and try again.

**`npm install` fails.** Check `node --version` is 20 or higher.

**`npm run dev` fails saying the port is in use.** A dev server is already
running in another terminal. Either use the one that is running, or stop it:

```bash
npx kill-port 5173
```

**The app loads but everything is empty.** Your account is probably still
inactive — see B4. You should be seeing the "waiting for approval" screen; if
you are not, the `.env` values may be pointing at the wrong project.

**Every webhook comes back 401.** The `SHOPIFY_WEBHOOK_SECRET` does not match.
Copy it again from Shopify's Notifications page.

**Everything shows as a sync mismatch.** The location ID is wrong — see Part C
step 3.
