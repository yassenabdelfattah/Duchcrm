/**
 * Shopify webhook signature verification.
 *
 * Anyone on the internet can POST to a webhook URL. The HMAC header is the
 * only thing distinguishing a real Shopify delivery from someone making up an
 * order to drain our stock, so this runs before the body is even parsed.
 */

const encoder = new TextEncoder();

/**
 * Compares two strings without leaking how much of the prefix matched.
 *
 * A plain `a === b` returns as soon as it finds a differing byte. Timing that
 * difference over many requests lets an attacker rebuild a valid signature one
 * byte at a time. This always walks the whole string.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Length is not secret, but returning early on it must not short-circuit the
  // comparison below, so mix it into the accumulator instead.
  let mismatch = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

let cachedKey: CryptoKey | null = null;
let cachedSecret: string | null = null;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedSecret = secret;
  return cachedKey;
}

/**
 * @param rawBody The request body as the exact bytes Shopify sent. Re-encoding
 *   a parsed object changes key order and whitespace and the signature will
 *   never match, so callers must pass `await req.text()` and parse afterwards.
 */
export async function isValidShopifyWebhook(
  rawBody: string,
  hmacHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader) return false;

  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return timingSafeEqual(expected, hmacHeader);
}

export interface ShopifyWebhookHeaders {
  topic: string;
  webhookId: string;
  eventId: string | null;
  shopDomain: string | null;
  apiVersion: string | null;
  triggeredAt: string | null;
}

export function readWebhookHeaders(headers: Headers): ShopifyWebhookHeaders | null {
  const topic = headers.get('x-shopify-topic');
  // The delivery id is our deduplication key. A webhook without one cannot be
  // processed safely, because we would have no way to recognise its replay.
  const webhookId = headers.get('x-shopify-webhook-id');
  if (!topic || !webhookId) return null;

  return {
    topic,
    webhookId,
    eventId: headers.get('x-shopify-event-id'),
    shopDomain: headers.get('x-shopify-shop-domain'),
    apiVersion: headers.get('x-shopify-api-version'),
    triggeredAt: headers.get('x-shopify-triggered-at'),
  };
}

export { timingSafeEqual };
