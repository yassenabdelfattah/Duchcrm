import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.',
  );
}

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
