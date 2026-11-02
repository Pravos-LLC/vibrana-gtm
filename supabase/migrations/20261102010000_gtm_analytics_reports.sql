-- Analytics reports: the weekly content review dashboard in the GTM cockpit (/performance/reports).
-- An agent writes each report from the cockpit's own data (the weekly-report skill) and publishes it as a
-- structured document; the cockpit renders it and a cron emails John a link once. Unlike
-- gtm_content_reports (the model-written report behind /performance/report/<week>), nothing here
-- proposes calendar changes: it is a read-only record to look back on.

create table public.gtm_analytics_reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('weekly')),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{2,80}$'),
  period_start date not null,
  period_end date not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  headline text not null check (length(btrim(headline)) between 1 and 400),
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  author text,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  email_id text,
  emailed_at timestamptz,
  constraint gtm_analytics_reports_period check (period_end >= period_start),
  constraint gtm_analytics_reports_once unique (kind, period_start)
);
create index gtm_analytics_reports_recent_idx on public.gtm_analytics_reports (kind, period_start desc);
create index gtm_analytics_reports_unsent_idx on public.gtm_analytics_reports (published_at) where emailed_at is null;

-- ---- access: owner reads, service role writes --------------------------------------------------

alter table public.gtm_analytics_reports enable row level security;
revoke all on public.gtm_analytics_reports from anon, authenticated;
grant select on public.gtm_analytics_reports to authenticated;
grant all on public.gtm_analytics_reports to service_role;
create policy gtm_analytics_reports_owner_read on public.gtm_analytics_reports for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
