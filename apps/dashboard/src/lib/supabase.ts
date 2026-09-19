import { createClient } from '@supabase/supabase-js';

const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!configuredUrl || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.',
  );
}

/**
 * Makes the local stack reachable when the page is opened from another device.
 *
 * During development VITE_SUPABASE_URL points at 127.0.0.1. That is correct on
 * the machine running everything, but a phone on the shop wifi loading the
 * dashboard from 192.168.1.x resolves 127.0.0.1 to *itself* - so the page
 * renders and then every request fails, which looks like the CRM being broken
 * rather than a networking detail.
 *
 * So when the page is being served from somewhere other than loopback and the
 * configured API is loopback, the API host is rewritten to match wherever the
 * page came from. Testing the sale screen on a real phone then needs no edit to
 * .env, and no re-edit when the router hands out a different address.
 *
 * Development only. A deployed build always uses exactly what it was given.
 */
function resolveApiUrl(configured: string): string {
  if (!import.meta.env.DEV || typeof window === 'undefined') return configured;

  try {
    const api = new URL(configured);
    const apiIsLoopback = api.hostname === 'localhost' || api.hostname === '127.0.0.1';
    const pageHost = window.location.hostname;
    const pageIsLoopback = pageHost === 'localhost' || pageHost === '127.0.0.1';

    if (apiIsLoopback && !pageIsLoopback) {
      api.hostname = pageHost;
      return api.origin;
    }
  } catch {
    // A malformed URL is caught by createClient below with a clearer message.
  }

  return configured;
}

const url = resolveApiUrl(configuredUrl);

/**
 * The browser client.
 *
 * This uses the anon key, which is public by design - it ships inside the
 * JavaScript bundle and anyone can read it. Row Level Security is what actually
 * protects the data. The service role key, which bypasses RLS, must never
 * appear in this app; it lives only in Edge Functions and the Worker.
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  db: { schema: 'public' },
});

/** Calls a Supabase Edge Function as the signed-in user. */
export async function invokeFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) throw error;
  return data as T;
}
