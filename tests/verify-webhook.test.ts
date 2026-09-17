import { describe, expect, it } from 'vitest';
import {
  isValidShopifyWebhook,
  readWebhookHeaders,
  timingSafeEqual,
} from '../supabase/functions/_shared/verify-webhook';

/**
 * Webhook signature verification is the only thing standing between the
 * storefront's order feed and anyone on the internet who knows the URL. A bug
 * here means someone can invent an order and drain our stock, so these tests
 * are about what must be rejected rather than what must be accepted.
 */

const SECRET = 'test-webhook-signing-secret';

/** Independent implementation of Shopify's scheme, so a bug in the code under
 *  test cannot also produce the expectation. */
async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Buffer.from(new Uint8Array(signature)).toString('base64');
}

describe('isValidShopifyWebhook', () => {
  const body = JSON.stringify({ id: 12345, inventory_item_id: 999, available: 7 });

  it('accepts a correctly signed body', async () => {
    const hmac = await sign(body);
    await expect(isValidShopifyWebhook(body, hmac, SECRET)).resolves.toBe(true);
  });

  it('rejects a body that was altered after signing', async () => {
    const hmac = await sign(body);
    const tampered = body.replace('"available":7', '"available":700');
    await expect(isValidShopifyWebhook(tampered, hmac, SECRET)).resolves.toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    const hmac = await sign(body, 'not-our-secret');
    await expect(isValidShopifyWebhook(body, hmac, SECRET)).resolves.toBe(false);
  });

  it('rejects a missing signature header', async () => {
    await expect(isValidShopifyWebhook(body, null, SECRET)).resolves.toBe(false);
  });

  it('rejects an empty signature header', async () => {
    await expect(isValidShopifyWebhook(body, '', SECRET)).resolves.toBe(false);
  });

  it('rejects a truncated but otherwise correct signature', async () => {
    const hmac = await sign(body);
    await expect(isValidShopifyWebhook(body, hmac.slice(0, -4), SECRET)).resolves.toBe(false);
  });

  it('is sensitive to whitespace, which is why the raw body must be used', async () => {
    // Re-serialising a parsed object changes spacing and key order. This test
    // exists to document why the handler signs `await req.text()` rather than
    // JSON.stringify(await req.json()).
    const hmac = await sign(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    await expect(isValidShopifyWebhook(reserialised, hmac, SECRET)).resolves.toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects strings differing only in the last character', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('rejects strings of different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('rejects an empty string against a real value', () => {
    expect(timingSafeEqual('', 'abc')).toBe(false);
  });
});

describe('readWebhookHeaders', () => {
  it('reads every header Shopify sends', () => {
    const headers = new Headers({
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': 'wh-1',
      'x-shopify-event-id': 'ev-1',
      'x-shopify-shop-domain': 'duch-store.myshopify.com',
      'x-shopify-api-version': '2026-07',
      'x-shopify-triggered-at': '2026-09-17T10:00:00Z',
    });

    expect(readWebhookHeaders(headers)).toEqual({
      topic: 'orders/create',
      webhookId: 'wh-1',
      eventId: 'ev-1',
      shopDomain: 'duch-store.myshopify.com',
      apiVersion: '2026-07',
      triggeredAt: '2026-09-17T10:00:00Z',
    });
  });

  it('refuses a delivery with no webhook id, because it could not be deduplicated', () => {
    const headers = new Headers({ 'x-shopify-topic': 'orders/create' });
    expect(readWebhookHeaders(headers)).toBeNull();
  });

  it('refuses a delivery with no topic', () => {
    const headers = new Headers({ 'x-shopify-webhook-id': 'wh-1' });
    expect(readWebhookHeaders(headers)).toBeNull();
  });
});
