-- Reports put together by hand, kept by name (2026-11-04).
--
-- The owner's ask: one report for a date range with the parts they choose -
-- net sales, each variant's net sales, the top sellers, the return rate - and
-- a way to keep it. A saved report is its name, its parts, and whether it
-- counts the orders still open in the range; the dates are picked each time
-- it is opened. Everyone who can see the reports sees the saved ones, and can
-- change or delete them: they are the shop's reports, not one person's.

create table public.saved_reports (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 1 and 80),
  -- The parts, in the order they are shown. The app knows what each one is;
  -- a part it no longer knows is skipped, not an error.
  sections     text[] not null check (cardinality(sections) between 1 and 20),
  -- Orders placed in the range that have not reached the customer yet:
  -- counted as sold, as every other report does, unless this is off.
  include_open boolean not null default true,
  created_by   uuid references public.staff(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.saved_reports is
  'Reports put together on the reports screen and kept by name. The date range is chosen when one is opened.';

-- Two reports with one name would be the same report to whoever picks it.
create unique index saved_reports_name_idx on public.saved_reports (lower(btrim(name)));

create trigger saved_reports_touch_updated_at
  before update on public.saved_reports
  for each row execute function public.touch_updated_at();

alter table public.saved_reports enable row level security;

create policy saved_reports_select on public.saved_reports
  for select to authenticated
  using ((select public.has_permission('reports.read')));

create policy saved_reports_insert on public.saved_reports
  for insert to authenticated
  with check ((select public.has_permission('reports.read')));

create policy saved_reports_update on public.saved_reports
  for update to authenticated
  using ((select public.has_permission('reports.read')))
  with check ((select public.has_permission('reports.read')));

create policy saved_reports_delete on public.saved_reports
  for delete to authenticated
  using ((select public.has_permission('reports.read')));

grant select, insert, update, delete on public.saved_reports to authenticated;
