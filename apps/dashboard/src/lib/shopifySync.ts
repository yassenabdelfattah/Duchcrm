import { supabase } from './supabase';

/**
 * Sends a website order's change to Shopify now, instead of within the
 * minute the Worker takes.
 *
 * The database already queued it when the change was saved, so this only
 * hurries it along: a failure here is retried by the Worker, and three in a
 * row show on Sync issues. Never throws - the change itself is saved either
 * way. Returns whether Shopify has it.
 */
export async function sendOrderToShopify(orderId: string): Promise<boolean> {
  const send = supabase.functions
    .invoke<{ processed?: number; failed?: number }>('shopify-order-sync', { body: { order_id: orderId } })
    .then(({ data, error }) => !error && (data?.failed ?? 0) === 0)
    .catch(() => false);
  // Nobody waits on Shopify at the counter: after a few seconds the screen
  // moves on. The request still finishes on the server, and if it does not,
  // the Worker sends it within the minute.
  const patience = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WAIT_MS));
  return Promise.race([send, patience]);
}

const WAIT_MS = 8000;
