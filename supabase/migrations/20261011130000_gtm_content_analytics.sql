-- Content analytics and the weekly content report (vibrana-gtm, VIB-417 / VIB-418).
--
-- 1. gtm_post_metrics becomes one snapshot per post, platform and UTC day. Two runners (the Vercel cron and
--    a Mac LaunchAgent) both appended a full snapshot, so some days held two to nine copies. The migration
--    keeps the latest snapshot of each day, then a unique key makes the sync an idempotent upsert.
--    `extras` holds the per-post metrics Zernio reports beyond the core counts (watch time, follows, skip
--    rate, sends, profile views), absent rather than zero when a platform does not report them.
-- 2. gtm_channel_daily gains the account-level impressions, reach and profile views for the day.
-- 3. gtm_manual_metrics: the weekly numbers no API exposes (Substack subscribers and opens, YouTube
--    impressions and click-through rate), entered by hand.
-- 4. gtm_content_reports (weekly reports and the recorded baseline) and gtm_report_actions (the calendar
--    changes a report proposes, each accepted or dismissed by John; accepting one edits gtm_content_items,
--    never approves or schedules anything).
-- 5. gtm_sync_state: small key/value state for the sync jobs (the Zernio analytics delta cursor).
--
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes.

-- ---- 1. gtm_post_metrics: one snapshot per day ------------------------------------------------

alter table public.gtm_post_metrics
  add column captured_on date generated always as ((captured_at at time zone 'UTC')::date) stored,
  add column extras jsonb not null default '{}'
    constraint gtm_post_metrics_extras_object check (jsonb_typeof(extras) = 'object');

-- Keep the latest snapshot of each (post, platform, day); later rows win, the larger id breaks a tie.
delete from public.gtm_post_metrics m
using public.gtm_post_metrics newer
where newer.zernio_post_id = m.zernio_post_id
  and newer.platform = m.platform
  and newer.captured_on = m.captured_on
  and (newer.captured_at > m.captured_at or (newer.captured_at = m.captured_at and newer.id > m.id));

alter table public.gtm_post_metrics
  add constraint gtm_post_metrics_daily unique (zernio_post_id, platform, captured_on);

create index if not exists gtm_post_metrics_item_idx on public.gtm_post_metrics (content_item_id) where content_item_id is not null;

-- The view's `*` was expanded when it was created; recreate it so it carries the new columns.
create or replace view public.gtm_post_metrics_latest with (security_invoker = true) as
select distinct on (zernio_post_id, platform) *
from public.gtm_post_metrics
order by zernio_post_id, platform, captured_at desc;

-- ---- 2. gtm_channel_daily: account-level reach -------------------------------------------------

alter table public.gtm_channel_daily
  add column impressions integer check (impressions >= 0),
  add column reach integer check (reach >= 0),
  add column profile_views integer check (profile_views >= 0);

-- ---- 3. gtm_manual_metrics ----------------------------------------------------------------------

create table public.gtm_manual_metrics (
  id uuid primary key default gen_random_uuid(),
  week_start date not null check (extract(isodow from week_start) = 1),
  channel text not null check (channel in ('substack_sample_author', 'substack_regenera', 'youtube', 'linkedin', 'instagram')),
  metrics jsonb not null default '{}' check (jsonb_typeof(metrics) = 'object'),
  note text not null default '',
  entered_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_manual_metrics_week_channel unique (week_start, channel)
);

-- ---- 4. gtm_content_reports and gtm_report_actions ---------------------------------------------

create table public.gtm_content_reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('weekly', 'baseline')),
  season_id text references public.gtm_seasons (id) on delete set null,
  week integer check (week >= 1),
  period_start date not null,
  period_end date not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  model text,
  headline text,
  input jsonb not null default '{}',
  report jsonb,
  guard jsonb not null default '{}',
  errors jsonb not null default '[]',
  email_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint gtm_content_reports_period check (period_end >= period_start),
  constraint gtm_content_reports_once unique (kind, period_start)
);
create index gtm_content_reports_recent_idx on public.gtm_content_reports (kind, period_start desc);
create index gtm_content_reports_season_idx on public.gtm_content_reports (season_id) where season_id is not null;

create table public.gtm_report_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.gtm_content_reports (id) on delete cascade,
  position integer not null default 0,
  type text not null check (type in ('move', 'swap', 'replace', 'new_story', 'change_format')),
  item_id text references public.gtm_content_items (id) on delete set null,
  other_item_id text references public.gtm_content_items (id) on delete set null,
  change jsonb not null default '{}' check (jsonb_typeof(change) = 'object'),
  proposal text not null check (length(btrim(proposal)) between 1 and 2000),
  rationale text not null default '',
  evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array'),
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  applied jsonb,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint gtm_report_actions_decided check ((status = 'proposed') = (decided_at is null))
);
create index gtm_report_actions_report_idx on public.gtm_report_actions (report_id, position);
create index gtm_report_actions_item_idx on public.gtm_report_actions (item_id) where item_id is not null;
create index gtm_report_actions_other_item_idx on public.gtm_report_actions (other_item_id) where other_item_id is not null;

-- ---- 5. gtm_sync_state --------------------------------------------------------------------------

create table public.gtm_sync_state (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]*$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---- access: owner reads, service role writes --------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['gtm_manual_metrics', 'gtm_content_reports', 'gtm_report_actions', 'gtm_sync_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$, t || '_owner_read', t);
  end loop;
end $$;

-- ---- 6. gtm_swap_slots: an accepted swap moves two calendar items in one statement ----------------
-- Both items trade date and time (the stored week follows the date), or neither does: anything already
-- scheduled, published, failed, skipped or handed to Zernio refuses the whole swap. Invoker rights; only
-- the service role (the cockpit server, after its owner check) may call it.
create function public.gtm_swap_slots(p_a text, p_b text)
returns setof public.gtm_content_items
language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  if p_a is null or p_b is null or p_a = p_b then
    raise exception 'a swap needs two different calendar items' using errcode = '22023';
  end if;
  return query
    update public.gtm_content_items t
       set date = s.date, time = s.time, week = extract(week from s.date)::integer
      from public.gtm_content_items s
     where ((t.id = p_a and s.id = p_b) or (t.id = p_b and s.id = p_a))
       and t.status in ('idea', 'drafted', 'approved') and t.zernio_post_id is null
       and s.status in ('idea', 'drafted', 'approved') and s.zernio_post_id is null
    returning t.*;
  get diagnostics n = row_count;
  if n <> 2 then
    raise exception 'both items must exist and be unscheduled (idea, drafted or approved, not in Zernio)' using errcode = '55000';
  end if;
end $$;
revoke all on function public.gtm_swap_slots(text, text) from public, anon, authenticated;
grant execute on function public.gtm_swap_slots(text, text) to service_role;
