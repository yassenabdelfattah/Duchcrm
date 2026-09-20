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

/**
 * Wraps a handler so a thrown error becomes a readable response.
 *
 * Without this the Edge runtime answers an uncaught throw with a bare 500 and
 * the words "Internal Server Error", and the reason is only visible in the
 * dashboard's log viewer. During setup that is the difference between "the
 * client secret is wrong" and half an hour of guessing - every one of these
 * functions fails first at configuration, not at logic.
 *
 * Only the message is returned, never the stack or the cause chain, since
 * these endpoints are reachable from outside.
 */
export function withErrorReporting(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : 'Error';
      console.error(`${name}: ${message}`);
      return json({ error: 'unhandled_error', name, detail: message }, 500);
    }
  };
}
