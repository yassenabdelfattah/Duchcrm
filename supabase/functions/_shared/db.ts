import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { config } from './env.ts';

/**
 * Service-role Supabase client.
 *
 * This key bypasses Row Level Security completely. It exists here, in code
 * that only ever runs on Supabase's servers, and must never be handed to the
 * browser - which is why the dashboard reads VITE_SUPABASE_ANON_KEY and has no
 * way to reach this value.
 */
let client: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
