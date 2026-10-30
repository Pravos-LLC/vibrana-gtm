-- The writing desk (GTM cockpit /outreach/write, VIB-437). John writes every cold email himself (2026-10-16: the agent
-- drafts were not good enough). For each person the desk shows everything we hold (the vibrana-crm dossier), his own
-- profile and gold examples, and a composer that autosaves to gtm_outreach_drafts as variant 'john', batch 'desk', so
-- the existing version history, `gtm outreach queue|mark` and the LinkedIn runbook keep working unchanged.
--
-- 1. gtm_outreach_drafts gets `person` (the Twenty person id; '' for pipeline drafts, which stay one per company), so two
--    people at one company can each have their own email. The key, the one-accepted index and gtm_outreach_accept now
--    include it; for every existing row (person = '') they behave exactly as before.
-- 2. email_sent_at / linkedin_sent_at: set by trigger the first time a status reaches sent, whoever marks it (the desk or
--    `gtm outreach mark`), so "sent today" against the daily target is counted from the database.
-- 3. gtm_outreach_dossiers: one row per Twenty person, upserted by `gtm outreach import-dossiers` (the whole dossier as
--    jsonb plus denormalized name, company, title, domain and score for the queue). John's skip (with a reason) lives here
--    and is never touched by a re-import.
-- 4. gtm_outreach_desk: one row. John's daily target (default 5, edited on the desk) and his profile JSON
--    (`gtm outreach import-profile`: facts, proof, assets, asks, voice, signature, gold examples).
--
-- Desk states, derived, not stored: to write (no desk draft), written (a desk draft, status pending), ready (accepted:
-- marking a channel sent accepts it, which is what the queue and the LinkedIn runbook read), sent (email_status sent or
-- replied), skipped (the dossier's skipped_at).
--
-- Personal data (prospect names, emails, research) lives only here and in Twenty, never in git. Like every gtm_* table:
-- RLS on, the owner reads, only the service role writes (the cockpit checks the owner claim, then writes with the secret key).

-- ---- 1. one draft per person -----------------------------------------------------------------------------------------
alter table public.gtm_outreach_drafts
  add column person text not null default '' check (person = '' or person ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  add column email_sent_at timestamptz,
  add column linkedin_sent_at timestamptz;
alter table public.gtm_outreach_drafts drop constraint gtm_outreach_drafts_key;
alter table public.gtm_outreach_drafts add constraint gtm_outreach_drafts_key unique (batch, domain, variant, person);
drop index public.gtm_outreach_drafts_one_accepted;
create unique index gtm_outreach_drafts_one_accepted on public.gtm_outreach_drafts (batch, domain, person) where status = 'accepted';
create index gtm_outreach_drafts_email_sent_idx on public.gtm_outreach_drafts (email_sent_at desc) where email_sent_at is not null;

-- ---- 2. when each channel was first sent --------------------------------------------------------------------------------
create function public.gtm_outreach_drafts_sent_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.email_status in ('sent', 'replied') and new.email_sent_at is null then new.email_sent_at := now(); end if;
  if new.linkedin_status in ('sent', 'connected') and new.linkedin_sent_at is null then new.linkedin_sent_at := now(); end if;
  return new;
end $$;
revoke all on function public.gtm_outreach_drafts_sent_at() from public, anon, authenticated;
create trigger gtm_outreach_drafts_sent_at before insert or update on public.gtm_outreach_drafts
  for each row execute function public.gtm_outreach_drafts_sent_at();

-- Rows marked sent before this migration: their best known time is the last update.
update public.gtm_outreach_drafts set email_sent_at = updated_at where email_status in ('sent', 'replied') and email_sent_at is null;
update public.gtm_outreach_drafts set linkedin_sent_at = updated_at where linkedin_status in ('sent', 'connected') and linkedin_sent_at is null;

-- Accept, as before, but siblings are the same person's other variants (person = '' for pipeline drafts: the company).
create or replace function public.gtm_outreach_accept(
  p_id uuid, p_actor text,
  p_subject text default null, p_body text default null, p_linkedin_note text default null, p_followups jsonb default null
) returns setof public.gtm_outreach_drafts
language plpgsql security invoker set search_path = '' as $$
declare d public.gtm_outreach_drafts; changed boolean;
begin
  select * into d from public.gtm_outreach_drafts where id = p_id for update;
  if not found then raise exception 'no outreach draft %', p_id using errcode = 'no_data_found'; end if;
  perform 1 from public.gtm_outreach_drafts s
    where s.batch = d.batch and s.domain = d.domain and s.person = d.person and s.id <> d.id for update;
  if exists (select 1 from public.gtm_outreach_drafts s
              where s.batch = d.batch and s.domain = d.domain and s.person = d.person and s.id <> d.id
                and (s.linkedin_status <> 'none' or s.email_status <> 'none')) then
    raise exception 'another variant for % was already acted on', d.domain using errcode = 'check_violation';
  end if;
  update public.gtm_outreach_drafts s
     set status = 'rejected', note = 'other variant chosen', decided_by = p_actor, decided_at = now()
   where s.batch = d.batch and s.domain = d.domain and s.person = d.person and s.id <> d.id and s.status <> 'rejected';
  changed := (coalesce(p_subject, d.subject), coalesce(p_body, d.body), coalesce(p_linkedin_note, d.linkedin_note), coalesce(p_followups, d.followups))
             is distinct from (d.subject, d.body, d.linkedin_note, d.followups);
  return query
  update public.gtm_outreach_drafts t
     set subject = coalesce(p_subject, t.subject), body = coalesce(p_body, t.body),
         linkedin_note = coalesce(p_linkedin_note, t.linkedin_note), followups = coalesce(p_followups, t.followups),
         edited_by = case when changed then p_actor else t.edited_by end,
         edited_at = case when changed then now() else t.edited_at end,
         status = 'accepted', decided_by = p_actor, decided_at = now()
   where t.id = d.id
  returning t.*;
end $$;
revoke all on function public.gtm_outreach_accept(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.gtm_outreach_accept(uuid, text, text, text, text, jsonb) to service_role;

-- ---- 3. dossiers ------------------------------------------------------------------------------------------------------
create table public.gtm_outreach_dossiers (
  twenty_person_id text primary key check (twenty_person_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  domain text check (domain is null or (length(domain) <= 253 and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')),
  name text not null default '' check (length(name) <= 300),
  company text not null default '' check (length(company) <= 300),
  title text not null default '' check (length(title) <= 300),
  score numeric,
  built_at timestamptz,
  -- The vibrana-crm desk export, whole: prospect, company, signal, triggers, sources, brief, person, colleagues, history, client_check.
  dossier jsonb not null default '{}' check (jsonb_typeof(dossier) = 'object' and octet_length(dossier::text) <= 2000000),
  -- John's skip, with why. A re-import never touches these.
  skipped_at timestamptz,
  skip_reason text not null default '' check (length(skip_reason) <= 2000),
  skipped_by text check (skipped_by is null or length(skipped_by) <= 200),
  constraint gtm_outreach_dossiers_skip check (skipped_at is not null or (skip_reason = '' and skipped_by is null))
);
create index gtm_outreach_dossiers_score_idx on public.gtm_outreach_dossiers (score desc nulls last, name);
create index gtm_outreach_dossiers_domain_idx on public.gtm_outreach_dossiers (domain);
create trigger gtm_outreach_dossiers_touch before update on public.gtm_outreach_dossiers
  for each row execute function public.gtm_outreach_drafts_touch();

alter table public.gtm_outreach_dossiers enable row level security;
revoke all on public.gtm_outreach_dossiers from anon, authenticated;
grant all on public.gtm_outreach_dossiers to service_role;
grant select on public.gtm_outreach_dossiers to authenticated;
create policy gtm_outreach_dossiers_owner_read on public.gtm_outreach_dossiers for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- ---- 4. the desk: daily target and John's profile ---------------------------------------------------------------------
create table public.gtm_outreach_desk (
  id boolean primary key default true check (id),
  updated_at timestamptz not null default now(),
  updated_by text check (updated_by is null or length(updated_by) <= 200),
  daily_target integer not null default 5 check (daily_target between 1 and 200),
  -- vibrana-crm qualification/outreach_profile.json: facts, proof, assets, asks, voice, signature, gold_examples.
  profile jsonb not null default '{}' check (jsonb_typeof(profile) = 'object' and octet_length(profile::text) <= 500000),
  profile_imported_at timestamptz
);
insert into public.gtm_outreach_desk default values;
create trigger gtm_outreach_desk_touch before update on public.gtm_outreach_desk
  for each row execute function public.gtm_outreach_drafts_touch();

alter table public.gtm_outreach_desk enable row level security;
revoke all on public.gtm_outreach_desk from anon, authenticated;
grant all on public.gtm_outreach_desk to service_role;
grant select on public.gtm_outreach_desk to authenticated;
create policy gtm_outreach_desk_owner_read on public.gtm_outreach_desk for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
