import { describe, expect, it } from 'vitest';
import {
  ShopifyAuthError,
  createShopifyTokenProvider,
  requestClientCredentialsToken,
} from '../supabase/functions/_shared/shopify-token';

/**
 * Shopify tokens now expire after 24 hours, so the integration depends on
 * this cache handing back a live one. The failure it guards against is quiet:
 * stock pushes start returning 401 a day after deployment, long after anyone
 * is watching the deploy.
 */

const CREDENTIALS = {
  domain: 'ducheg.myshopify.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
};

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('requestClientCredentialsToken', () => {
  it('posts form-encoded credentials to the shop token endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return tokenResponse({ access_token: 'shpca_abc', expires_in: 86399, scope: 'read_products' });
    }) as unknown as typeof fetch;

    await requestClientCredentialsToken(CREDENTIALS, fetchImpl, () => 1_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ducheg.myshopify.com/admin/oauth/access_token');
    expect(calls[0].init.method).toBe('POST');
    // Shopify answers a JSON body with an unexplained 400, so the encoding
    // matters more than it looks.
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );

    const sent = new URLSearchParams(calls[0].init.body as string);
    expect(sent.get('grant_type')).toBe('client_credentials');
    expect(sent.get('client_id')).toBe('test-client-id');
    expect(sent.get('client_secret')).toBe('test-client-secret');
  });

  it('turns expires_in into an absolute deadline', async () => {
    const fetchImpl = (async () =>
      tokenResponse({ access_token: 'shpca_abc', expires_in: 86399 })) as unknown as typeof fetch;

    const grant = await requestClientCredentialsToken(CREDENTIALS, fetchImpl, () => 10_000);

    expect(grant.token).toBe('shpca_abc');
    expect(grant.expiresAt).toBe(10_000 + 86_399_000);
  });

  it('treats a missing expires_in as an hour rather than as forever', async () => {
    const fetchImpl = (async () =>
      tokenResponse({ access_token: 'shpca_abc' })) as unknown as typeof fetch;

    const grant = await requestClientCredentialsToken(CREDENTIALS, fetchImpl, () => 0);

    // Guessing short costs one extra exchange. Guessing long means every call
    // fails for as long as the guess was wrong.
    expect(grant.expiresAt).toBe(3_600_000);
  });

  it('throws without echoing the credentials back into the logs', async () => {
    const fetchImpl = (async () =>
      new Response('client_secret test-client-secret is invalid', {
        status: 401,
      })) as unknown as typeof fetch;

    const error = await requestClientCredentialsToken(CREDENTIALS, fetchImpl).catch((e) => e);

    expect(error).toBeInstanceOf(ShopifyAuthError);
    expect(error.message).not.toContain('test-client-secret');
    expect(error.message).toContain('SHOPIFY_CLIENT_ID');
  });

  it("surfaces Shopify's error code, which separates a bad secret from an uninstalled app", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_client' }), {
        status: 400,
      })) as unknown as typeof fetch;

    const error = await requestClientCredentialsToken(CREDENTIALS, fetchImpl).catch((e) => e);

    expect(error.message).toContain('invalid_client');
    expect(error.message).toContain('ducheg.myshopify.com');
  });

  it('ignores an implausibly long error field rather than pasting a body into the logs', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'x'.repeat(200) }), {
        status: 400,
      })) as unknown as typeof fetch;

    const error = await requestClientCredentialsToken(CREDENTIALS, fetchImpl).catch((e) => e);

    expect(error.message).not.toContain('xxxxx');
  });

  it('rejects a success response that carries no token', async () => {
    const fetchImpl = (async () => tokenResponse({ scope: 'read_products' })) as unknown as typeof fetch;

    await expect(requestClientCredentialsToken(CREDENTIALS, fetchImpl)).rejects.toThrow(
      /no access_token/,
    );
  });
});

describe('createShopifyTokenProvider', () => {
  function counting(token = 'shpca_abc', expiresIn = 86399) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return tokenResponse({ access_token: `${token}-${calls}`, expires_in: expiresIn });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it('exchanges once and re-uses the token', async () => {
    const { fetchImpl, calls } = counting();
    const provider = createShopifyTokenProvider({
      credentials: CREDENTIALS,
      fetchImpl,
      now: () => 0,
    });

    expect(await provider.get()).toBe('shpca_abc-1');
    expect(await provider.get()).toBe('shpca_abc-1');
    expect(calls()).toBe(1);
  });

  it('exchanges again once the token is close to expiring', async () => {
    const { fetchImpl, calls } = counting();
    let clock = 0;
    const provider = createShopifyTokenProvider({
      credentials: CREDENTIALS,
      fetchImpl,
      now: () => clock,
      refreshMarginMs: 5 * 60 * 1000,
    });

    expect(await provider.get()).toBe('shpca_abc-1');

    // Just inside the margin: still good.
    clock = 86_399_000 - 5 * 60 * 1000 - 1;
    expect(await provider.get()).toBe('shpca_abc-1');
    expect(calls()).toBe(1);

    // Inside the margin: refreshed before it actually dies.
    clock = 86_399_000 - 5 * 60 * 1000 + 1;
    expect(await provider.get()).toBe('shpca_abc-2');
    expect(calls()).toBe(2);
  });

  it('does not stampede when several requests arrive on a cold instance', async () => {
    const { fetchImpl, calls } = counting();
    const provider = createShopifyTokenProvider({
      credentials: CREDENTIALS,
      fetchImpl,
      now: () => 0,
    });

    const tokens = await Promise.all([provider.get(), provider.get(), provider.get()]);

    expect(tokens).toEqual(['shpca_abc-1', 'shpca_abc-1', 'shpca_abc-1']);
    expect(calls()).toBe(1);
  });

  it('exchanges a new token after being invalidated', async () => {
    const { fetchImpl, calls } = counting();
    const provider = createShopifyTokenProvider({
      credentials: CREDENTIALS,
      fetchImpl,
      now: () => 0,
    });

    expect(await provider.get()).toBe('shpca_abc-1');
    provider.invalidate();
    expect(await provider.get()).toBe('shpca_abc-2');
    expect(calls()).toBe(2);
  });

  it('never calls Shopify when a legacy permanent token is configured', async () => {
    const { fetchImpl, calls } = counting();
    const provider = createShopifyTokenProvider({
      staticToken: 'shpat_legacy',
      credentials: CREDENTIALS,
      fetchImpl,
      now: () => 0,
    });

    expect(await provider.get()).toBe('shpat_legacy');
    expect(calls()).toBe(0);
  });

  it('says which secrets are missing when nothing is configured', async () => {
    const provider = createShopifyTokenProvider({ credentials: null });

    await expect(provider.get()).rejects.toThrow(/SHOPIFY_CLIENT_ID/);
  });
});
