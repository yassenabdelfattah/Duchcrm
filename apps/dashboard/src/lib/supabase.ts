import { createClient } from '@supabase/supabase-js';

const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Which of the two are missing, or null when the app is configured.
 *
 * These are baked in at build time, so "missing" means the build did not
 * have them - not something a reload will fix. Throwing here used to take
 * the whole app down before React mounted, leaving a white page whose only
 * explanation was a line in the browser console. Staff do not open the
 * console; they report that the app is broken. main.tsx renders this
 * instead.
 */
export const missingConfig: string[] = [
  !configuredUrl ? 'VITE_SUPABASE_URL' : null,
  !anonKey ? 'VITE_SUPABASE_ANON_KEY' : null,
].filter((name): name is string => name !== null);

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

// A placeholder when unconfigured: createClient() rejects an empty string,
// and main.tsx shows the configuration screen instead of ever using this.
const url = configuredUrl ? resolveApiUrl(configuredUrl) : 'https://unconfigured.invalid';

/**
 * The browser client.
 *
 * This uses the anon key, which is public by design - it ships inside the
 * JavaScript bundle and anyone can read it. Row Level Security is what actually
 * protects the data. The service role key, which bypasses RLS, must never
 * appear in this app; it lives only in Edge Functions and the Worker.
 */
// `||`, not `??`: an unset Vite variable is an empty string rather than
// undefined, and createClient rejects an empty key with "supabaseKey is
// required" before the configuration screen can render.
export const supabase = createClient(url, anonKey || 'unconfigured', {
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
