-- Outreach angle learning loop (writing desk, /outreach/write). John edits the generated angles (subject, body, LinkedIn
-- note) before he sends; each edit is a label on the generator's work. Mirrors the Engage loop (20261012120000):
-- 1. gtm_outreach_angle_runs: one row per "Generate angles" click, the three angles exactly as generated, the model, and
--    `lesson_set` (the set of lessons the angles were written with). This is the baseline a later edit is diffed against.
-- 2. gtm_outreach_angle_edits: one row per channel John marked sent from a generated angle (email: subject + body;
--    linkedin: the note). Holds the generated text, what he sent, the measured change, and the observations the learning
--    run wrote about the diff. `analyzed_at` null means the learning run has not read it yet. Undoing a mistaken
--    "Mark sent" deletes the row, so an email that never went out teaches nothing.
-- 3. gtm_outreach_lessons: what the generator learned from those edits. Active lessons go into every generation; John can
--    retire any of them or add his own in the desk.
-- 4. gtm_outreach_learn_runs: one row per learning run (stats, errors).
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes. Prospect text lives here only as
-- John's own words and the generator's, never as dossier data.

create table public.gtm_outreach_angle_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  person text not null check (person ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  track text not null default 'client' check (track in ('client', 'guest')),
  model text not null default '' check (length(model) <= 200),
  lesson_set text check (length(lesson_set) <= 64),
  -- [{key, label, subject, body, linkedin_note}] as the model returned them (the body as shown in the composer).
  angles jsonb not null check (jsonb_typeof(angles) = 'array' and octet_length(angles::text) <= 200000),
  created_by text
);
create index gtm_outreach_angle_runs_person_idx on public.gtm_outreach_angle_runs (person, created_at desc);

create table public.gtm_outreach_learn_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}',
  errors jsonb not null default '[]'
);

create table public.gtm_outreach_angle_edits (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id uuid not null references public.gtm_outreach_angle_runs (id) on delete cascade,
  draft_id uuid not null references public.gtm_outreach_drafts (id) on delete cascade,
  person text not null,
  channel text not null check (channel in ('email', 'linkedin')),
  angle_key text not null check (angle_key in ('light_touch', 'direct_fit', 'useful_value')),
  lesson_set text check (length(lesson_set) <= 64),
  generated jsonb not null check (jsonb_typeof(generated) = 'object'),
  final jsonb not null check (jsonb_typeof(final) = 'object'),
  -- Measured, not model-written: per field, word counts and the share of generated words John kept, in order.
  stats jsonb not null default '{}',
  observations jsonb not null default '[]' check (jsonb_typeof(observations) = 'array'),
  analyzed_at timestamptz,
  constraint gtm_outreach_angle_edits_once unique (draft_id, channel)
);
create index gtm_outreach_angle_edits_pending_idx on public.gtm_outreach_angle_edits (created_at) where analyzed_at is null;
create index gtm_outreach_angle_edits_run_idx on public.gtm_outreach_angle_edits (run_id);

create table public.gtm_outreach_lessons (
  id uuid primary key default gen_random_uuid(),
  -- Where in the message the lesson applies; rule_conflict: John's own sends break a fixed drafting rule, which only John
  -- can change.
  kind text not null check (kind in ('subject', 'opening', 'body', 'ask', 'linkedin', 'rule_conflict')),
  lesson text not null check (length(btrim(lesson)) between 3 and 500),
  -- The gtm_outreach_angle_edits rows the lesson was drawn from.
  evidence uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'retired')),
  source text not null default 'learned' check (source in ('learned', 'john')),
  run_id uuid references public.gtm_outreach_learn_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by text,
  constraint gtm_outreach_lessons_retired_has_time check (status <> 'retired' or retired_at is not null)
);
create index gtm_outreach_lessons_active_idx on public.gtm_outreach_lessons (kind, created_at) where status = 'active';
create index gtm_outreach_lessons_run_idx on public.gtm_outreach_lessons (run_id) where run_id is not null;

do $$
declare t text;
begin
  foreach t in array array['gtm_outreach_angle_runs', 'gtm_outreach_angle_edits', 'gtm_outreach_lessons', 'gtm_outreach_learn_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$, t || '_owner_read', t);
  end loop;
end $$;
