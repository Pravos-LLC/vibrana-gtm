-- Pipeline dashboard (gtm.vibrana.ai/pipeline, VIB-499): the sales side of the funnel, measured against John's
-- $10k/month take-home goal. Definitions: hub gtm/strategy/pipeline-metrics.md.
--
-- 1. gtm_outreach_drafts gains reply outcomes: when a desk email was answered or bounced (written by the cockpit's
--    hourly pipeline cron from the outreach mailbox) and how John labels the reply. "Positive" is John's call, one
--    click in the inbox; no model guesses it.
-- 2. gtm_deal_milestones: payment milestones per Twenty opportunity (deposit, demo, acceptance), with the date cash
--    arrived. Take-home is computed from cash collected, so this is the ledger the goal reads.
-- 3. gtm_deal_stage_history: the first time the daily sync saw each opportunity at each stage, so win rate and cycle
--    time come from recorded dates, not from today's stage alone.
-- 4. gtm_linkedin_connections / gtm_linkedin_threads: metadata from John's weekly LinkedIn data export. No message
--    text, no names, no profile URLs: profiles and threads are keyed hashes, linked to Twenty by person id only.
-- 5. gtm_web_daily: per site and day, aggregates from the Vercel Web Analytics API.
-- Pipeline settings (goal, overhead, FX, planning rates) live in gtm_settings under the key "pipeline".

alter table public.gtm_outreach_drafts
  add column email_replied_at timestamptz,
  add column email_bounced_at timestamptz,
  add column reply_sentiment text check (reply_sentiment is null or reply_sentiment in ('positive', 'neutral', 'negative', 'not_now', 'unsubscribe')),
  add column reply_labeled_at timestamptz;

create table public.gtm_deal_milestones (
  id bigint generated always as identity primary key,
  opportunity_id uuid not null,
  label text not null check (length(btrim(label)) between 1 and 60),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  due_on date,
  invoiced_at timestamptz,
  paid_at timestamptz,
  paid_amount numeric(12, 2) check (paid_amount is null or paid_amount > 0),
  payment_ref text check (payment_ref is null or length(payment_ref) <= 120),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_deal_milestones_label_once unique (opportunity_id, label),
  constraint gtm_deal_milestones_paid_amount check ((paid_at is null) = (paid_amount is null))
);
create index gtm_deal_milestones_paid_idx on public.gtm_deal_milestones (paid_at) where paid_at is not null;
-- One Wise credit pays one milestone: `gtm sales reconcile` records it as wise:<reference>, and a second match is refused here.
create unique index gtm_deal_milestones_wise_ref_once on public.gtm_deal_milestones (payment_ref) where payment_ref like 'wise:%';

create table public.gtm_deal_stage_history (
  opportunity_id uuid not null,
  stage text not null check (stage ~ '^[A-Z][A-Z_]{1,29}$'),
  first_seen_at timestamptz not null default now(),
  primary key (opportunity_id, stage)
);

create table public.gtm_linkedin_connections (
  owner text not null check (owner ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  profile_hash text not null check (profile_hash ~ '^[a-f0-9]{64}$'),
  connected_on date not null,
  person_id uuid,
  icp boolean not null default false,
  imported_at timestamptz not null default now(),
  primary key (owner, profile_hash)
);
create index gtm_linkedin_connections_on_idx on public.gtm_linkedin_connections (owner, connected_on desc);

create table public.gtm_linkedin_threads (
  owner text not null check (owner ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  thread_hash text not null check (thread_hash ~ '^[a-f0-9]{64}$'),
  person_id uuid,
  icp boolean not null default false,
  first_at timestamptz not null,
  last_at timestamptz not null check (last_at >= first_at),
  started_by_owner boolean not null,
  two_way boolean not null,
  messages integer not null check (messages >= 1),
  owner_messages integer not null check (owner_messages >= 0),
  imported_at timestamptz not null default now(),
  primary key (owner, thread_hash),
  constraint gtm_linkedin_threads_counts check (owner_messages <= messages)
);
create index gtm_linkedin_threads_first_idx on public.gtm_linkedin_threads (owner, first_at desc);

create table public.gtm_web_daily (
  site text not null check (site ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  day date not null,
  visitors integer not null check (visitors >= 0),
  pageviews integer not null check (pageviews >= 0),
  high_intent integer check (high_intent is null or high_intent >= 0),
  paths jsonb not null default '[]' check (jsonb_typeof(paths) = 'array'),
  referrers jsonb not null default '[]' check (jsonb_typeof(referrers) = 'array'),
  utm jsonb not null default '[]' check (jsonb_typeof(utm) = 'array'),
  captured_at timestamptz not null default now(),
  primary key (site, day)
);

-- ---- access: the owner reads, the service role writes (cockpit server actions check the owner first) ----------

alter table public.gtm_deal_milestones enable row level security;
alter table public.gtm_deal_stage_history enable row level security;
alter table public.gtm_linkedin_connections enable row level security;
alter table public.gtm_linkedin_threads enable row level security;
alter table public.gtm_web_daily enable row level security;
revoke all on public.gtm_deal_milestones, public.gtm_deal_stage_history, public.gtm_linkedin_connections,
  public.gtm_linkedin_threads, public.gtm_web_daily from anon, authenticated;
grant all on public.gtm_deal_milestones, public.gtm_deal_stage_history, public.gtm_linkedin_connections,
  public.gtm_linkedin_threads, public.gtm_web_daily to service_role;
grant select on public.gtm_deal_milestones, public.gtm_deal_stage_history, public.gtm_linkedin_connections,
  public.gtm_linkedin_threads, public.gtm_web_daily to authenticated;

create policy gtm_deal_milestones_owner_read on public.gtm_deal_milestones for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_deal_stage_history_owner_read on public.gtm_deal_stage_history for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_linkedin_connections_owner_read on public.gtm_linkedin_connections for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_linkedin_threads_owner_read on public.gtm_linkedin_threads for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_web_daily_owner_read on public.gtm_web_daily for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
