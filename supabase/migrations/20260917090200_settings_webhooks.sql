-- ---------------------------------------------------------------------------
-- Phase 1: app settings and the webhook inbox.
-- ---------------------------------------------------------------------------

create table public.settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.staff (id) on delete set null
);

comment on table public.settings is
  'Operational toggles an admin can change without a deploy. Secrets never go here.';

create trigger settings_touch_updated_at
  before update on public.settings
  for each row execute function public.touch_updated_at();

insert into public.settings (key, value, description) values
  ('shopify_push_enabled', 'true'::jsonb,
   'Master switch for outbound inventory pushes. Turn off during bulk imports.'),
  ('shopify_inventory_state', '"available"'::jsonb,
   'Which Shopify quantity state the CRM mirrors. See DECISIONS.md #1.'),
  ('echo_window_seconds', '120'::jsonb,
   'How long after our own push an identical inventory webhook is treated as an echo.'),
  ('reconcile_tolerance', '0'::jsonb,
   'Quantity difference tolerated before the nightly job opens a sync issue.');

-- --- Webhook inbox ---------------------------------------------------------
--
-- Shopify retries a webhook it believes failed, and can deliver the same event
-- more than once even when it did not. Every delivery is written here first,
-- and the unique constraint on shopify_webhook_id is what makes the handlers
-- idempotent: a replay hits the conflict and is acknowledged without being
-- processed a second time.

create type public.webhook_status as enum ('received', 'processing', 'processed', 'ignored', 'failed');

create table public.webhook_events (
  id                  uuid primary key default gen_random_uuid(),
  shopify_webhook_id  text not null unique,
  shopify_event_id    text,
  topic               text not null,
  shop_domain         text,
  api_version         text,
  payload             jsonb not null,
  status              public.webhook_status not null default 'received',
  ignored_reason      text,
  error               text,
  attempts            integer not null default 0,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz
);

comment on column public.webhook_events.shopify_webhook_id is
  'X-Shopify-Webhook-Id header. Unique per delivery attempt group - the dedupe key.';
comment on column public.webhook_events.shopify_event_id is
  'X-Shopify-Event-Id header. Shared by every webhook caused by one merchant action.';
comment on column public.webhook_events.ignored_reason is
  'Why a delivery was deliberately not acted on, e.g. ''echo_of_own_push''.';

create index webhook_events_topic_received_idx on public.webhook_events (topic, received_at desc);
create index webhook_events_status_idx on public.webhook_events (status)
  where status in ('received', 'processing', 'failed');
create index webhook_events_event_id_idx on public.webhook_events (shopify_event_id)
  where shopify_event_id is not null;
