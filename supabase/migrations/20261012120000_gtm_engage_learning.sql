-- Engage learning loop and commenter profiles (VIB-428).
-- 1. Who a commenter is, at a glance: their public profile basics (headline, company, website, follower count,
--    profile link), read once per author from the platform's public profile. Only these fields are kept, on the
--    comment row; nothing else from the profile is stored.
-- 2. John's corrections: `reclassified_from` records the agent's label John overruled (e.g. "not spam"), so the
--    learning run can learn classification as well as voice.
-- 3. gtm_engage_lessons: what the agent learned from the gap between its drafts and what John sent, skipped or
--    corrected. Active lessons go into every drafting call; John can retire any of them, or add his own, in /engage.
--    `lesson_set` on a comment names the set of lessons its draft was written with, so the cockpit can show
--    whether drafts get closer to what John sends as lessons change.
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes.

alter table public.gtm_comments
  add column author_headline text check (length(author_headline) <= 400),
  add column author_company text check (length(author_company) <= 200),
  add column author_website text check (author_website ~ '^https?://' and length(author_website) <= 500),
  add column author_profile_url text check (author_profile_url ~ '^https?://' and length(author_profile_url) <= 500),
  add column author_enriched_at timestamptz,
  add column reclassified_from text check (reclassified_from in ('reply', 'needs_john', 'spam', 'skip')),
  add column lesson_set text check (length(lesson_set) <= 64);

create index gtm_comments_enrich_idx on public.gtm_comments (received_at) where author_enriched_at is null and not is_own;

alter table public.gtm_comment_runs drop constraint gtm_comment_runs_kind_check;
alter table public.gtm_comment_runs add constraint gtm_comment_runs_kind_check check (kind in ('daily', 'intake_email', 'learn'));

create table public.gtm_engage_lessons (
  id uuid primary key default gen_random_uuid(),
  -- voice: how John's replies sound; classification: what counts as spam, needs-John or skip;
  -- rule_conflict: John's own replies break a fixed drafting rule, which only John can change.
  kind text not null check (kind in ('voice', 'classification', 'rule_conflict')),
  lesson text not null check (length(btrim(lesson)) between 3 and 500),
  -- The gtm_comments rows the lesson was drawn from.
  evidence uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'retired')),
  source text not null default 'learned' check (source in ('learned', 'john')),
  run_id uuid references public.gtm_comment_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by text,
  constraint gtm_engage_lessons_retired_has_time check (status <> 'retired' or retired_at is not null)
);
create index gtm_engage_lessons_active_idx on public.gtm_engage_lessons (kind, created_at) where status = 'active';
create index gtm_engage_lessons_run_idx on public.gtm_engage_lessons (run_id) where run_id is not null;

alter table public.gtm_engage_lessons enable row level security;
revoke all on public.gtm_engage_lessons from anon, authenticated;
grant all on public.gtm_engage_lessons to service_role;
grant select on public.gtm_engage_lessons to authenticated;
create policy gtm_engage_lessons_owner_read on public.gtm_engage_lessons for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
