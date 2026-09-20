/**
 * Environment access for Edge Functions.
 *
 * Every secret is read through here so that a missing one fails loudly at
 * startup with a message naming the variable, rather than producing a
 * confusing 401 from Shopify twenty minutes later.
 */

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it with: supabase secrets set ${name}=...`,
    );
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = Deno.env.get(name);
  return value && value.trim() !== '' ? value : fallback;
}

export const config = {
  get supabaseUrl() {
    return requireEnv('SUPABASE_URL');
  },
  /** Bypasses Row Level Security. Only ever used server-side. */
  get serviceRoleKey() {
    return requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  },
  get shopifyDomain() {
    return requireEnv('SHOPIFY_STORE_DOMAIN');
  },
  /**
   * A legacy permanent token from an admin-created custom app. Shopify no
   * longer issues these, so it is optional - an empty string means "use the
   * client credentials below instead". See shopify-token.ts.
   */
  get shopifyStaticToken() {
    return optionalEnv('SHOPIFY_ADMIN_API_TOKEN', '');
  },
  get shopifyClientId() {
    return optionalEnv('SHOPIFY_CLIENT_ID', '');
  },
  get shopifyClientSecret() {
    return optionalEnv('SHOPIFY_CLIENT_SECRET', '');
  },
  get shopifyWebhookSecret() {
    return requireEnv('SHOPIFY_WEBHOOK_SECRET');
  },
  get shopifyLocationId() {
    return requireEnv('SHOPIFY_LOCATION_ID');
  },
  /**
   * Pinned deliberately. Shopify ships a new version every quarter and drops
   * old ones after about a year; "latest" would mean the integration changes
   * under us without a deploy.
   */
  get shopifyApiVersion() {
    return optionalEnv('SHOPIFY_API_VERSION', '2026-07');
  },
};
