# Accurate Logistics — integration notes

**Status: not started. Waiting on API documentation.**

Nothing has been written against Accurate's API, and nothing will be until
their documentation is provided. Guessing endpoint paths, field names or
authentication shapes would produce code that looks finished, passes its own
invented tests, and fails the first time it meets the real service.

## What is known so far

From the brief:

- Their shipping software is built by **Accurate Smart Solutions**.
- Access needs a **backend URL** and an **access token**.
- A shipment needs a **zone**, a **subzone**, and a **shipping service type**.

Placeholders already exist for the first two, empty:

```
ACCURATE_BASE_URL=
ACCURATE_ACCESS_TOKEN=
```

## What is needed to start

When you have the documentation, these are the questions that shape the schema,
so they are worth answering before any code is written:

1. **Authentication.** Is the access token a static header, or exchanged for a
   short-lived one? Does it expire?
2. **Creating a shipment.** What is the request body, and what comes back — a
   tracking number immediately, or a job that is polled?
3. **Zones and subzones.** Is there an endpoint listing them, or is it a fixed
   list to be stored? Are they chosen per shipment, or fixed per customer
   address? This decides whether the CRM stores a zone on the customer, on the
   order, or looks it up at booking time.
4. **Service types.** What are the options, and do they affect price?
5. **Tracking.** Is there a status endpoint to poll, or do they push updates to
   a webhook? Polling is assumed — the Worker already has a cron schedule ready
   for it.
6. **Status values.** The exact list, so CRM order statuses can map onto them
   rather than being invented.
7. **Cash on delivery.** How is the amount to collect declared, and how is the
   money reconciled back? This matters more than the rest — COD is a large
   share of Egyptian e-commerce, and an order marked delivered but unreconciled
   is money nobody is chasing.
8. **Rate limits and sandbox.** Is there a test environment? Shipping something
   by accident during development is an expensive way to find out there was not.

## How it will be built

To match the rest of the system:

- An Edge Function per operation, keeping all Accurate code in one place.
- Requests and responses logged to a table, as `shopify_inventory_pushes` does
  — when a parcel goes missing, what was actually sent matters.
- Booking a shipment recorded as a state change on the order, never as an edit
  to a status column with no history.
- Tracking updates polled by the existing Worker.
- The token used only server-side, never reaching the dashboard.

## What to send

The documentation in whatever form you have it — a PDF, a Postman collection,
a link to their developer portal — plus test credentials if they provide a
sandbox.
