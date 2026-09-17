# Connecting the CRM to Shopify

Everything here is done once. Follow it in order — the webhook step needs the
Edge Function URL, which needs the functions deployed.

The CRM is pinned to Shopify Admin API version **2026-07**. Shopify ships a new
version every quarter and retires each one after about a year, so this needs
revisiting around mid-2027. The version lives in one place:
`SHOPIFY_API_VERSION`.

---

## 1. Create the custom app

In Shopify admin:

1. **Settings → Apps and sales channels → Develop apps**
2. **Allow custom app development** if you have not before. This is a one-time
   store-wide setting and needs the store owner account.
3. **Create an app**. Name it `Duch CRM`.

### Scopes

Under **Configuration → Admin API integration → Configure**, enable exactly
these:

| Scope | Why the CRM needs it |
|---|---|
| `read_products` | Importing the catalogue |
| `read_inventory` | Reading quantities for the nightly comparison |
| `write_inventory` | Pushing our quantities to the storefront |
| `read_orders` | Phase 3 — website orders |
| `read_customers` | Phase 3 — matching customers across channels |
| `read_locations` | Resolving the location ID |

Do not grant `write_products` or `write_orders`. The CRM does not create
products or orders in Shopify, and a token that cannot do something is a token
that cannot do it by accident.

### Get the token

**API credentials → Install app**, then reveal the **Admin API access token**.
It starts with `shpat_` and **is shown exactly once** — copy it now.

```bash
supabase secrets set SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxxxxxxxxx
supabase secrets set SHOPIFY_STORE_DOMAIN=duch-store.myshopify.com
supabase secrets set SHOPIFY_API_VERSION=2026-07
```

Use the `.myshopify.com` domain, not `duch.store`. The custom domain is for
customers; the API only answers on the Shopify one.

---

## 2. Find your location ID

The CRM mirrors stock at exactly one Shopify location. Find its numeric ID:

```bash
curl -s -X POST "https://duch-store.myshopify.com/admin/api/2026-07/graphql.json" -H "X-Shopify-Access-Token: $SHOPIFY_ADMIN_API_TOKEN" -H "Content-Type: application/json" -d '{"query":"{ locations(first: 10) { nodes { id name isActive } } }"}'
```

You will get IDs shaped like `gid://shopify/Location/1234567890`. The CRM wants
the number on the end only:

```bash
supabase secrets set SHOPIFY_LOCATION_ID=1234567890
```

Then link it to the CRM location, so the sync knows which is which:

```sql
update public.locations set shopify_location_id = 1234567890 where is_default;
```

If that number is wrong, the nightly check will report every single variant as
a mismatch — which is at least a loud failure rather than a quiet one.

---

## 3. Deploy the Edge Functions

```bash
supabase functions deploy shopify-webhook shopify-import-products push-inventory reconcile-stock
```

Your webhook URL is:

```
https://<your-project-ref>.supabase.co/functions/v1/shopify-webhook
```

---

## 4. Register the webhooks

In Shopify admin: **Settings → Notifications → Webhooks → Create webhook**.
Format **JSON**, API version **2026-07**, and the URL above.

Create one for each of:

| Event | What the CRM does with it |
|---|---|
| `Inventory level update` | Classifies it as our own echo, agreement, or an unexplained difference. Never changes stock. |
| `Product update` | Keeps titles, prices and barcodes current |
| `Order creation` | Phase 3 — stored now so it can be backfilled |
| `Order update` | Phase 3 |
| `Order cancellation` | Phase 3 |
| `Refund create` | Phase 3 |

The Phase 3 topics are worth registering now. Their payloads are stored from
day one, so when those handlers are written they can be replayed from
`webhook_events` rather than lost.

### The signing secret

After creating the first webhook, Shopify shows a signing secret at the bottom
of the Notifications page. Every webhook from this store uses the same one.

```bash
supabase secrets set SHOPIFY_WEBHOOK_SECRET=your-signing-secret
```

Without this the receiver rejects every delivery with a 401 — which is correct
behaviour, since it cannot tell a real Shopify request from anyone else's.

---

## 5. Import the catalogue

Start with a dry run, which reads Shopify and writes nothing:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/shopify-import-products" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d '{"dry_run": true}'
```

Check `variants_skipped_no_sku` in the response. **Every variant needs a SKU.**
The import will not invent one, because an invented SKU diverges from the
barcode printed on the actual garment and you would not find out until someone
scans it at the till. Fix any that are missing in Shopify, then run for real:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/shopify-import-products" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d '{}'
```

### Opening stock

Once, to bring current Shopify quantities in as the opening balance:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/shopify-import-products" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d '{"import_opening_stock": true, "location_id": "<crm-location-uuid>"}'
```

This writes `initial_import` movements through the ledger like any other stock
change — there is no path that sets a quantity directly. It refuses to run
twice for a variant that already has history, so a mistaken second run cannot
double your stock.

**Count the shop by hand before you trust this.** Whatever Shopify currently
says is your opening balance, and every future number is built on it.

---

## 6. Deploy the scheduled jobs

```bash
cd apps/worker
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler deploy
```

Optionally add `ALERT_WEBHOOK_URL` (a Slack or Discord incoming webhook) to be
told when the nightly job fails or when the ledger and its running total
disagree — the second one would mean a bug in the CRM itself.

---

## Checking it works

1. Adjust stock for one variant in the CRM. Within a second or two the Shopify
   admin should show the new number.
2. Look at `shopify_inventory_pushes` — there should be a `succeeded` row.
3. Look at `webhook_events` — Shopify's echo should be there, with
   `ignored_reason` of `inventory_echo`. **That is success, not failure**: it
   means the loop protection recognised our own push coming back.
4. Change a quantity directly in the Shopify admin. The next nightly run should
   open a `quantity_mismatch` on the Sync issues screen rather than silently
   overwriting it.

---

## If something is wrong

**Every webhook returns 401.** `SHOPIFY_WEBHOOK_SECRET` does not match. Copy it
again from Settings → Notifications; regenerating a webhook changes it.

**Pushes fail with an idempotency error.** Shopify has required an idempotency
key on inventory mutations since API version 2026-04. `IDEMPOTENCY_KEY_
PARAMETER_MISMATCH` means a key was reused with different arguments — the push
code handles this by generating a fresh key when it retries, so seeing it
repeatedly means something is calling the API outside that path.

**Everything shows as a mismatch.** Usually `SHOPIFY_LOCATION_ID` and
`locations.shopify_location_id` disagree, or point at a location that is not
the one the storefront sells from.

**A variant will not sync.** Check `shopify_inventory_item_id` on the variant.
It is null if the variant was created in the CRM, or if the import ran before
that variant existed in Shopify. Re-run the import.
