/**
 * Duch CRM scheduled jobs.
 *
 * The Worker is deliberately thin. All the Shopify logic lives in Supabase
 * Edge Functions so there is exactly one implementation of it; this just wakes
 * those functions up on a schedule and reports whether they worked.
 *
 * Schedules are declared in wrangler.toml:
 *   every minute  drain the inventory outbox (the safety net behind the fast
 *                 push the sale screen makes directly)
 *   00:00 UTC     nightly reconciliation, roughly 2am in Cairo
 */

export interface Env {
  SUPABASE_URL: string;
  /** Bypasses Row Level Security. A Worker secret, never in source. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Optional: a Slack or Discord webhook to shout into when a job fails. */
  ALERT_WEBHOOK_URL?: string;
}

const OUTBOX_CRON = '* * * * *';
const NIGHTLY_CRON = '0 0 * * *';

async function callEdgeFunction(
  env: Env,
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Leave it as text; a non-JSON body is itself useful in the log.
  }

  return { ok: response.ok, status: response.status, body: parsed };
}

async function alert(env: Env, message: string, detail: unknown): Promise<void> {
  console.error(message, detail);
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Duch CRM: ${message}\n\`\`\`${JSON.stringify(detail)}\`\`\`` }),
    });
  } catch (error) {
    console.error('Could not deliver alert', error);
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case OUTBOX_CRON: {
        ctx.waitUntil(
          (async () => {
            const result = await callEdgeFunction(env, 'push-inventory', { drain: true, limit: 50 });
            if (!result.ok) {
              // Not alert-worthy on its own: the outbox retries with backoff,
              // and a variant that keeps failing opens a sync issue by itself.
              console.warn('push-inventory drain did not succeed', result);
            } else {
              const pushed = (result.body as { pushed?: number })?.pushed ?? 0;
              if (pushed > 0) console.log(`Pushed ${pushed} inventory levels to Shopify`);
            }
          })(),
        );
        break;
      }

      case NIGHTLY_CRON: {
        ctx.waitUntil(
          (async () => {
            const result = await callEdgeFunction(env, 'reconcile-stock', {});
            if (!result.ok) {
              await alert(env, 'Nightly stock reconciliation failed', result);
              return;
            }
            const summary = result.body as {
              mismatched?: number;
              unmapped?: number;
              internal_drift_rows?: number;
            };
            console.log('Reconciliation summary', summary);

            // Internal drift means our own ledger and its cache disagree.
            // That is a bug in the CRM and deserves waking someone up.
            if ((summary.internal_drift_rows ?? 0) > 0) {
              await alert(env, 'Stock level cache has drifted from the ledger', summary);
            }
          })(),
        );
        break;
      }

      default:
        console.warn(`No job registered for cron "${event.cron}"`);
    }
  },

  /**
   * A plain HTTP entry point, so the jobs can be triggered by hand while
   * setting things up. Requires the service role key as a bearer token, so it
   * is no weaker than the Supabase functions it calls.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'duch-crm-worker' });
    }

    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (url.pathname === '/run/push-inventory') {
      return Response.json(await callEdgeFunction(env, 'push-inventory', { drain: true }));
    }

    if (url.pathname === '/run/reconcile') {
      return Response.json(await callEdgeFunction(env, 'reconcile-stock', {}));
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
