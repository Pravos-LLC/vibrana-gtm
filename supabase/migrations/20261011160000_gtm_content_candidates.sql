-- Sunday candidates (vibrana-gtm, VIB-420). Every Sunday afternoon a routine picks 5 to 7 stories from the
-- Signal Desk and the morning's weekly report, drafts each one in John's voice (writers room, rubric judge) and
-- puts the drafts here. John reads them in the cockpit (/signals?view=candidates): Send to Review stages one as a
-- Story with drafted calendar items, Edit changes it inline, Reject records why.
--
-- 1. gtm_content_candidates: one row per drafted candidate and week. `agent_draft` freezes the version the agent
--    wrote and `edits` keeps every change John makes before sending it on, so the pair is voice signal.
--    Accepting never approves or schedules anything: the staged items go through /content review as usual.
-- 2. gtm_signal_feedback gains a `reject` action with a reason, and the candidate it came from, so a rejected
--    candidate is a taste label on its signal like every other action.
--
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes.

-- ---- 1. gtm_content_candidates ----------------------------------------------------------------------

create table public.gtm_content_candidates (
  id uuid primary key default gen_random_uuid(),
  -- The Monday of the week the candidates are for (the routine runs the Sunday before).
  week_start date not null check (extract(isodow from week_start) = 1),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position integer not null default 0 check (position >= 0),
  status text not null default 'candidate' check (status in ('candidate', 'accepted', 'rejected')),
  format text not null check (format in ('text', 'carousel', 'video')),
  lens text not null check (lens in ('transformation', 'thought_leadership', 'regenerative')),
  pillar text not null check (pillar in ('proof', 'perspective', 'build', 'lists')),
  channels text[] not null
    check (cardinality(channels) between 1 and 3 and channels <@ array['linkedin', 'instagram', 'youtube']::text[]),
  title text not null check (length(btrim(title)) between 1 and 300),
  -- The post text (linkedin.md): a text post, or the caption that goes with the slides or the video.
  body text not null check (length(btrim(body)) between 1 and 20000),
  -- The Instagram caption when it differs from the LinkedIn text (no links on Instagram).
  instagram text check (length(instagram) <= 5000),
  -- A carousel's slides.json in the vibrana-carousel schema ({template, slides: [...]}).
  slides jsonb check (slides is null or jsonb_typeof(slides) = 'object'),
  -- A video script: {hook, beats: [...], lines: "<video-lines.md>"}.
  video jsonb check (video is null or jsonb_typeof(video) = 'object'),
  sources jsonb not null check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1),
  rubric jsonb not null default '{}' check (jsonb_typeof(rubric) = 'object'),
  score real check (score >= 0 and score <= 100),
  -- The content-canon taxonomy ids the draft uses: {hook, story, cta}.
  playbook jsonb not null default '{}' check (jsonb_typeof(playbook) = 'object'),
  signal_id uuid references public.gtm_signal_stories (id) on delete set null,
  report_action_id uuid references public.gtm_report_actions (id) on delete set null,
  agent_draft jsonb not null check (jsonb_typeof(agent_draft) = 'object'),
  edits jsonb not null default '[]' check (jsonb_typeof(edits) = 'array'),
  reject_reason text check (reject_reason in ('angle', 'voice', 'facts', 'timing', 'duplicate', 'topic', 'other')),
  reject_note text check (length(reject_note) <= 2000),
  gtm_story_id text references public.gtm_stories (id) on delete set null,
  content_item_ids text[] not null default '{}',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_content_candidates_payload check (
    (format <> 'carousel' or slides is not null) and (format <> 'video' or video is not null)
  ),
  constraint gtm_content_candidates_decided check ((status = 'candidate') = (decided_at is null)),
  constraint gtm_content_candidates_rejected check ((status = 'rejected') = (reject_reason is not null)),
  constraint gtm_content_candidates_once unique (week_start, slug)
);
create index gtm_content_candidates_week_idx on public.gtm_content_candidates (week_start desc, position);
create index gtm_content_candidates_status_idx on public.gtm_content_candidates (status, week_start desc);
create index gtm_content_candidates_signal_idx on public.gtm_content_candidates (signal_id) where signal_id is not null;
create index gtm_content_candidates_action_idx on public.gtm_content_candidates (report_action_id) where report_action_id is not null;
create index gtm_content_candidates_story_idx on public.gtm_content_candidates (gtm_story_id) where gtm_story_id is not null;

-- ---- 2. gtm_signal_feedback: reject with a reason ----------------------------------------------------

alter table public.gtm_signal_feedback drop constraint gtm_signal_feedback_action_check;
alter table public.gtm_signal_feedback
  add constraint gtm_signal_feedback_action_check
    check (action in ('save', 'queue', 'dismiss', 'restore', 'drafted', 'reject')),
  add column reason text check (length(reason) <= 2000),
  add column candidate_id uuid references public.gtm_content_candidates (id) on delete set null,
  add constraint gtm_signal_feedback_reject_reason check (action <> 'reject' or reason is not null);
create index gtm_signal_feedback_candidate_idx on public.gtm_signal_feedback (candidate_id) where candidate_id is not null;

-- ---- access: owner reads, service role writes --------------------------------------------------------

alter table public.gtm_content_candidates enable row level security;
revoke all on public.gtm_content_candidates from anon, authenticated;
grant select on public.gtm_content_candidates to authenticated;
grant all on public.gtm_content_candidates to service_role;
create policy gtm_content_candidates_owner_read on public.gtm_content_candidates for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
