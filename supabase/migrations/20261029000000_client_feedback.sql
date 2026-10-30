-- Client feedback responses for /feedback/[slug] (first form: Sample Person-pst).
--
-- Deny by default: RLS is on, there are NO policies, and anon/authenticated hold no grants.
-- The only writer is the server route app/api/feedback/route.ts using the service-role key.
-- The respondent's user agent is stored as a salted hash only, never raw.
--
-- consent_text_version + consent_text_snapshot record the exact wording the respondent was
-- shown, so a later change to the form never rewrites what someone agreed to. They are null
-- when the consent screen was not shown (overall_score below 8).
--
-- Additive only: creates one table. Not applied automatically; apply in the Supabase SQL
-- editor (or `supabase db push`) before the form goes live. The form shows a retry error
-- until it exists, and no answers are lost: they stay in the respondent's browser.

create table if not exists public.client_feedback (
  id                    uuid        primary key default gen_random_uuid(),
  slug                  text        not null check (char_length(slug) between 1 and 64),
  respondent_token      text        check (respondent_token is null or char_length(respondent_token) <= 32),
  respondent_name       text        check (respondent_name is null or char_length(respondent_name) <= 120),
  answers               jsonb       not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  overall_score         smallint    check (overall_score is null or overall_score between 0 and 10),
  consent               jsonb       check (consent is null or jsonb_typeof(consent) = 'object'),
  consent_text_version  text,
  consent_text_snapshot text,
  consent_at            timestamptz,
  user_agent_hash       text        check (user_agent_hash is null or char_length(user_agent_hash) <= 64),
  created_at            timestamptz not null default now(),
  -- Consent can only exist for a score of 8 or more, and always with the wording it was given on.
  -- The 8 mirrors CONSENT_DB_MIN_SCORE in lib/feedback/submission.ts; a form's consent.minScore must be
  -- at least that (a test checks both). Change them together.
  constraint client_feedback_consent_gate check (
    consent is null
    or (overall_score >= 8 and consent_text_version is not null and consent_text_snapshot is not null)
  ),
  constraint client_feedback_consent_at_needs_consent check (consent_at is null or consent is not null)
);

comment on table public.client_feedback is
  'Client feedback form responses. Service-role writes only (app/api/feedback). No client access.';

create index if not exists client_feedback_slug_created_idx
  on public.client_feedback (slug, created_at desc);

alter table public.client_feedback enable row level security;
revoke all on table public.client_feedback from anon, authenticated;
-- Explicit, because fresh databases don't grant service_role by default.
grant select, insert, update, delete on table public.client_feedback to service_role;
