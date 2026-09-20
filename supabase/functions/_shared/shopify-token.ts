/**
 * Getting an Admin API token, and keeping one.
 *
 * Shopify retired admin-created custom apps - the kind where you copied a
 * permanent `shpat_` token out of the admin once and pasted it into a secret.
 * New apps are made in the Dev Dashboard and hold a client id and secret,
 * which are exchanged for an access token that **expires after 24 hours**
 * (`expires_in` is 86399). Non-expiring offline tokens are being withdrawn as
 * well, so there is no longer a "set it and forget it" credential to store.
 *
 * That turns a static secret into a small piece of machinery: fetch a token,
 * remember it, and fetch another before the old one dies. It is cached in
 * module scope, which lives as long as the Edge Function instance does, so a
 * warm instance re-uses one token across many requests and a cold start pays
 * for one extra round trip.
 *
 * A legacy `shpat_` token still works if one is configured. Existing installs
 * keep running, and the exchange only happens when there is no static token.
 */

/** Refresh this long before expiry rather than racing the deadline. */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ClientCredentials {
  domain: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenGrant {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
}

export class ShopifyAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ShopifyAuthError';
  }
}

/**
 * Removes the credentials from a string before it is logged or returned.
 *
 * Shopify's refusal messages sometimes quote back what was sent. This message
 * travels into function logs and an HTTP response, so the id and secret are
 * stripped before either sees them.
 */
function redact(text: string, credentials: ClientCredentials): string {
  let safe = text;
  for (const value of [credentials.clientSecret, credentials.clientId]) {
    if (value && value.length >= 6) safe = safe.split(value).join('[redacted]');
  }
  return safe;
}

/**
 * One exchange. No caching, no retries - the caller owns both.
 *
 * The endpoint wants form encoding, not JSON. Sending JSON returns a 400 that
 * does not say why, which is a miserable thing to debug at deploy time.
 */
export async function requestClientCredentialsToken(
  credentials: ClientCredentials,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TokenGrant> {
  const url = `https://${credentials.domain}/admin/oauth/access_token`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }).toString(),
  });

  const raw = await response.text();

  if (!response.ok) {
    // Shopify's own short code, and only that. The full body is deliberately
    // not echoed: a failed exchange can reflect the credentials back, and
    // this message ends up in function logs and HTTP responses. The code is
    // worth having because it separates the two causes that look identical
    // from outside - `invalid_client` is a wrong id or secret, while
    // `invalid_request` usually means the app is not installed on the store.
    // Shopify is inconsistent here: the OAuth endpoint answers some failures
    // with {"error": "invalid_client"} and others with {"errors": "Invalid
    // API key or access token"} - singular code, or plural sentence. Reading
    // only the singular one silently discards the more descriptive half.
    let code = '';
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; errors?: unknown };
      const detail = [parsed.error, parsed.errors].find((v) => typeof v === 'string') as
        | string
        | undefined;

      if (detail) {
        code = ` Shopify said: ${redact(detail.slice(0, 200), credentials)}.`;
      }
    } catch {
      // Not JSON. Fall through to the raw body below.
    }

    // Some refusals are not JSON at all - an HTML error page, or nothing.
    // Saying "Shopify refused it" and discarding the only evidence makes the
    // failure unfixable from the outside, so a redacted, truncated,
    // whitespace-collapsed excerpt goes in instead.
    if (!code && raw.trim()) {
      const excerpt = redact(raw.replace(/\s+/g, ' ').trim().slice(0, 200), credentials);
      code = ` Shopify said: ${excerpt}.`;
    }

    throw new ShopifyAuthError(
      `Shopify refused the client credentials grant (${response.status}).${code} ` +
        `Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET against the Dev Dashboard, ` +
        `and that the app is installed on ${credentials.domain}.`,
      response.status,
      null,
    );
  }

  let parsed: { access_token?: string; expires_in?: number; scope?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShopifyAuthError('Shopify returned a non-JSON token response', response.status, null);
  }

  if (!parsed.access_token) {
    throw new ShopifyAuthError('Shopify returned no access_token', response.status, null);
  }

  // Treat a missing expires_in as one hour rather than as forever. Guessing
  // short costs an extra exchange; guessing long means every call 401s for
  // however long the guess was wrong.
  const lifetimeSeconds = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;

  return {
    token: parsed.access_token,
    expiresAt: now() + lifetimeSeconds * 1000,
    scope: parsed.scope ?? '',
  };
}

export interface TokenProviderOptions {
  /** A legacy permanent token. When present, nothing is ever exchanged. */
  staticToken?: string | null;
  credentials?: ClientCredentials | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshMarginMs?: number;
}

export interface TokenProvider {
  get(): Promise<string>;
  /** Drop the cached token, so the next get() exchanges a fresh one. */
  invalidate(): void;
}

export function createShopifyTokenProvider(options: TokenProviderOptions): TokenProvider {
  const {
    staticToken,
    credentials,
    fetchImpl = fetch,
    now = Date.now,
    refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS,
  } = options;

  let cached: TokenGrant | null = null;
  // Concurrent callers share one exchange. Without this a cold instance
  // handling several requests at once would ask Shopify for a token per
  // request, and Shopify rate-limits the token endpoint like any other.
  let inFlight: Promise<TokenGrant> | null = null;

  function fresh(grant: TokenGrant | null): boolean {
    return grant !== null && grant.expiresAt - refreshMarginMs > now();
  }

  return {
    async get(): Promise<string> {
      if (staticToken) return staticToken;

      if (!credentials) {
        throw new ShopifyAuthError(
          'No Shopify credentials configured. Set SHOPIFY_CLIENT_ID and ' +
            'SHOPIFY_CLIENT_SECRET (or a legacy SHOPIFY_ADMIN_API_TOKEN).',
          0,
          null,
        );
      }

      if (fresh(cached)) return cached!.token;

      if (!inFlight) {
        inFlight = requestClientCredentialsToken(credentials, fetchImpl, now).finally(() => {
          inFlight = null;
        });
      }

      cached = await inFlight;
      return cached.token;
    },

    invalidate(): void {
      cached = null;
    },
  };
}
