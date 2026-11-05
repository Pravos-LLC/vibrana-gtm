-- YouTube channel analytics (replaces the weekly manual YouTube entry).
-- Source: the YouTube Analytics API (views, watch time, retention, subscribers, traffic, country), the YouTube
-- Reporting API reach report channel_reach_basic_a1 (thumbnail impressions and click-through rate, per video per day)
-- and the Data API (titles, duration, live subscriber count). The same tables take a Studio CSV export
-- (`gtm youtube import`) so history can be backfilled before the API is connected.
-- Every metric column is nullable: null means "this source did not report it", never zero.

create table public.gtm_yt_videos (
  video_id text primary key check (video_id ~ '^[A-Za-z0-9_-]{6,20}$'),
  title text not null default '',
  published_at timestamptz,
  duration_s integer check (duration_s is null or duration_s >= 0),
  is_short boolean,
  updated_at timestamptz not null default now()
);

create table public.gtm_yt_video_daily (
  date date not null,
  video_id text not null references public.gtm_yt_videos (video_id) on delete cascade,
  views integer check (views >= 0),
  watch_minutes numeric check (watch_minutes >= 0),
  avg_view_duration_s numeric check (avg_view_duration_s >= 0),
  avg_view_pct numeric check (avg_view_pct between 0 and 100),
  subs_gained integer check (subs_gained >= 0),
  subs_lost integer check (subs_lost >= 0),
  likes integer check (likes >= 0),
  comments integer check (comments >= 0),
  shares integer check (shares >= 0),
  impressions integer check (impressions >= 0),
  ctr numeric check (ctr between 0 and 100),
  source text not null default 'api',
  updated_at timestamptz not null default now(),
  primary key (date, video_id)
);
create index gtm_yt_video_daily_video_idx on public.gtm_yt_video_daily (video_id, date desc);

create table public.gtm_yt_channel_daily (
  date date primary key,
  views integer check (views >= 0),
  watch_minutes numeric check (watch_minutes >= 0),
  avg_view_duration_s numeric check (avg_view_duration_s >= 0),
  subs_gained integer check (subs_gained >= 0),
  subs_lost integer check (subs_lost >= 0),
  subscribers_total integer check (subscribers_total >= 0),
  impressions integer check (impressions >= 0),
  ctr numeric check (ctr between 0 and 100),
  source text not null default 'api',
  updated_at timestamptz not null default now()
);

-- Traffic source and country, one row per (date, dimension, key).
create table public.gtm_yt_dim_daily (
  date date not null,
  dimension text not null check (dimension in ('traffic_source', 'country')),
  key text not null check (length(key) between 1 and 80),
  views integer check (views >= 0),
  watch_minutes numeric check (watch_minutes >= 0),
  source text not null default 'api',
  updated_at timestamptz not null default now(),
  primary key (date, dimension, key)
);

-- Which Reporting API reports were already ingested, so a re-run never double counts.
create table public.gtm_yt_report_files (
  report_id text primary key,
  report_type text not null,
  start_date date,
  end_date date,
  rows_ingested integer not null default 0,
  ingested_at timestamptz not null default now()
);

alter table public.gtm_yt_videos enable row level security;
alter table public.gtm_yt_video_daily enable row level security;
alter table public.gtm_yt_channel_daily enable row level security;
alter table public.gtm_yt_dim_daily enable row level security;
alter table public.gtm_yt_report_files enable row level security;
revoke all on public.gtm_yt_videos, public.gtm_yt_video_daily, public.gtm_yt_channel_daily, public.gtm_yt_dim_daily, public.gtm_yt_report_files from anon, authenticated;
grant select on public.gtm_yt_videos, public.gtm_yt_video_daily, public.gtm_yt_channel_daily, public.gtm_yt_dim_daily, public.gtm_yt_report_files to authenticated;
grant all on public.gtm_yt_videos, public.gtm_yt_video_daily, public.gtm_yt_channel_daily, public.gtm_yt_dim_daily, public.gtm_yt_report_files to service_role;

create policy gtm_yt_videos_owner_read on public.gtm_yt_videos for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_yt_video_daily_owner_read on public.gtm_yt_video_daily for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_yt_channel_daily_owner_read on public.gtm_yt_channel_daily for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_yt_dim_daily_owner_read on public.gtm_yt_dim_daily for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_yt_report_files_owner_read on public.gtm_yt_report_files for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
