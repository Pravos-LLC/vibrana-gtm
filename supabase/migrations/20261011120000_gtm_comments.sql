-- Engage queue (VIB-423): comments and DMs from other people on John's channels, with an agent-drafted
-- reply John approves once a day in the cockpit's /engage page. Comments arrive from Zernio (the
-- comment.received / message.received webhooks and a daily poll) and, for LinkedIn posts Zernio does not
-- track, from LinkedIn's notification emails. `draft` is the agent's text and `final_text` what John sent,
-- so the pair is voice signal (`edited` says whether he changed it).
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes.

create table public.gtm_comments (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'comment' check (kind in ('comment', 'dm')),
  source text not null check (source in ('webhook', 'poll', 'email')),
  platform text not null check (platform ~ '^[a-z]{1,20}$'),
  -- Zernio account id (null for email intake).
  account_id text,
  zernio_post_id text,
  platform_post_id text,
  content_item_id text references public.gtm_content_items (id) on delete set null,
  -- The platform's comment id (a DM: the Zernio message id; an email: the comment URN, else a hash).
  external_id text not null check (length(btrim(external_id)) between 1 and 500),
  parent_external_id text,
  conversation_id text,
  author_id text,
  author_username text,
  author_name text,
  author_picture text,
  text text not null default '' check (length(text) <= 10000),
  post_preview text check (length(post_preview) <= 2000),
  permalink text check (permalink ~ '^https?://'),
  comment_url text check (comment_url ~ '^https?://'),
  is_own boolean not null default false,
  commented_at timestamptz,
  received_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new', 'drafted', 'approved', 'sent', 'skipped', 'hidden', 'failed')),
  classification text check (classification in ('reply', 'needs_john', 'spam', 'skip')),
  draft text check (length(draft) <= 5000),
  draft_reason text check (length(draft_reason) <= 1000),
  draft_model text,
  drafted_at timestamptz,
  final_text text check (length(final_text) <= 5000),
  edited boolean generated always as (final_text is not null and draft is not null and btrim(final_text) <> btrim(draft)) stored,
  reply_external_id text,
  sent_at timestamptz,
  acted_by text,
  acted_at timestamptz,
  note text check (length(note) <= 1000),
  error text check (length(error) <= 2000),
  updated_at timestamptz not null default now(),
  constraint gtm_comments_external_key unique (platform, kind, external_id),
  constraint gtm_comments_sent_has_time check (status <> 'sent' or sent_at is not null),
  constraint gtm_comments_dm_has_conversation check (kind <> 'dm' or conversation_id is not null)
);
create index gtm_comments_queue_idx on public.gtm_comments (status, commented_at desc);
create index gtm_comments_counts_idx on public.gtm_comments (commented_at) where not is_own;
create index gtm_comments_content_item_idx on public.gtm_comments (content_item_id) where content_item_id is not null;
create index gtm_comments_post_idx on public.gtm_comments (platform, platform_post_id);

-- One row per daily run (poll + draft + email) and per LinkedIn email intake, with absolute counts.
create table public.gtm_comment_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('daily', 'intake_email')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}',
  errors jsonb not null default '[]'
);
create index gtm_comment_runs_recent_idx on public.gtm_comment_runs (kind, started_at desc);

alter table public.gtm_comments enable row level security;
alter table public.gtm_comment_runs enable row level security;

revoke all on public.gtm_comments, public.gtm_comment_runs from anon, authenticated;
grant all on public.gtm_comments, public.gtm_comment_runs to service_role;
grant select on public.gtm_comments, public.gtm_comment_runs to authenticated;

create policy gtm_comments_owner_read on public.gtm_comments for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_comment_runs_owner_read on public.gtm_comment_runs for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
