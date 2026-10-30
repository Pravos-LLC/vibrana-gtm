-- Signal Desk: timely AI stories gathered from the open web and John's X activity, classified by a
-- decision model (Cloudflare Clef), clustered into stories and ranked for the cockpit's /signals page
-- and the morning digest. Items are raw sightings; a story groups the sightings of one piece of news.
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes. Team members who
-- are not the owner reach /signals through the cockpit server, which checks their claim first.

create table public.gtm_signal_stories (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 500),
  lanes text[] not null default '{}' check (lanes::text ~ '^\{([a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*)?\}$'),
  score real not null default 0,
  velocity real not null default 0,
  source_count integer not null default 1 check (source_count >= 0),
  item_count integer not null default 1 check (item_count >= 0),
  centroid real[],
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  brief jsonb,
  briefed_at timestamptz,
  status text not null default 'new' check (status in ('new', 'saved', 'queued', 'drafted', 'dismissed')),
  requested_format text check (requested_format in ('story', 'repost', 'video')),
  gtm_story_id text references public.gtm_stories (id) on delete set null,
  acted_by text,
  acted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint gtm_signal_stories_queued_format check (status <> 'queued' or requested_format is not null)
);
create index gtm_signal_stories_recent_idx on public.gtm_signal_stories (last_seen desc);
create index gtm_signal_stories_rank_idx on public.gtm_signal_stories (status, score desc);
create index gtm_signal_stories_gtm_story_idx on public.gtm_signal_stories (gtm_story_id) where gtm_story_id is not null;

create table public.gtm_signal_items (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~ '^https?://'),
  source text not null check (length(btrim(source)) between 1 and 200),
  source_kind text not null check (source_kind in (
    'rss', 'hn', 'github', 'arxiv', 'hf', 'gdelt', 'reddit',
    'bluesky', 'x_bookmark', 'x_like', 'x_list', 'x_search', 'x_news', 'x_user'
  )),
  author text,
  title text not null check (length(title) <= 1000),
  body text not null default '' check (length(body) <= 20000),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  metrics jsonb not null default '{}',
  lanes jsonb,
  flags jsonb,
  relevant boolean,
  classified_at timestamptz,
  embedding real[],
  story_id uuid references public.gtm_signal_stories (id) on delete set null
);
create index gtm_signal_items_story_idx on public.gtm_signal_items (story_id);
create index gtm_signal_items_fetched_idx on public.gtm_signal_items (fetched_at desc);
create index gtm_signal_items_unclassified_idx on public.gtm_signal_items (fetched_at) where classified_at is null;

-- Every action on a story is a taste label: what John (or the team) wanted more or less of.
create table public.gtm_signal_feedback (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.gtm_signal_stories (id) on delete cascade,
  actor text not null check (length(btrim(actor)) between 1 and 320),
  action text not null check (action in ('save', 'queue', 'dismiss', 'restore', 'drafted')),
  format text check (format in ('story', 'repost', 'video')),
  created_at timestamptz not null default now()
);
create index gtm_signal_feedback_story_idx on public.gtm_signal_feedback (story_id, created_at);

-- One row per pipeline run, with absolute counts per source, so a silent source shows up as zero.
create table public.gtm_signal_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('collect', 'collect_x', 'digest')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}',
  errors jsonb not null default '[]'
);
create index gtm_signal_runs_recent_idx on public.gtm_signal_runs (kind, started_at desc);

alter table public.gtm_signal_stories enable row level security;
alter table public.gtm_signal_items enable row level security;
alter table public.gtm_signal_feedback enable row level security;
alter table public.gtm_signal_runs enable row level security;

revoke all on public.gtm_signal_stories, public.gtm_signal_items, public.gtm_signal_feedback, public.gtm_signal_runs from anon, authenticated;
grant all on public.gtm_signal_stories, public.gtm_signal_items, public.gtm_signal_feedback, public.gtm_signal_runs to service_role;
grant select on public.gtm_signal_stories, public.gtm_signal_items, public.gtm_signal_feedback, public.gtm_signal_runs to authenticated;

create policy gtm_signal_stories_owner_read on public.gtm_signal_stories for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_signal_items_owner_read on public.gtm_signal_items for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_signal_feedback_owner_read on public.gtm_signal_feedback for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_signal_runs_owner_read on public.gtm_signal_runs for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
