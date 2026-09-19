import { createClient } from '@supabase/supabase-js';

const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!configuredUrl || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.',
  );
}

/**
 * Where the API lives.
 *
 * In development the dashboard talks to Supabase through its own dev server,
 * at /supabase, rather than directly at 127.0.0.1:54321. That is one port to
 * reach instead of two, which matters the moment the page is opened from
 * anywhere but this machine: a phone resolves 127.0.0.1 to itself, and a
 * firewall or a router that isolates devices will happily serve the page while
 * blocking the API. Going through one origin removes the whole class of
 * problem, and makes a tunnel a single URL rather than two.
 *
 * A production build always uses exactly the URL it was given.
 */
function resolveApiUrl(configured: string): string {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    return `${window.location.origin}/supabase`;
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
