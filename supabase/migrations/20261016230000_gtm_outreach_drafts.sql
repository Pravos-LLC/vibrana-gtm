-- Personalized cold outreach, reviewed in the GTM cockpit (/outreach, VIB-437). The Python pipeline in vibrana-crm
-- researches each prospect (a trigger, a strategy, sourced claims) and drafts an email, a LinkedIn note and follow-ups;
-- `gtm outreach import` loads them here, John reviews them in /outreach the way he reviews posts in /content (edit
-- inline, accept, reject, or send back with a note), and `gtm outreach notes` hands his notes back to the pipeline.
--
-- One row per draft: (batch, domain, variant). A model trial puts several variants of the same prospect side by side;
-- accepting one rejects its siblings (gtm_outreach_accept below), and at most one variant per prospect is accepted.
-- original_subject / original_body freeze the agent's draft, so John's edits can be diffed later as training signal.
-- Only an accepted draft is ever acted on (queued, sent, connected): the table refuses anything else.
--
-- History: every change to the text (subject, body, LinkedIn note, follow-ups) keeps the previous text in
-- gtm_outreach_draft_versions, written by a trigger whoever makes the change: "edited" (John, in /outreach),
-- "regenerated" (the pipeline replaced a draft John sent back; his note is kept with the old text), or "reimported"
-- (the pipeline re-ran a draft nobody had touched yet).
--
-- Personal data (prospect names, emails) lives only here and in Twenty, never in git. Like every gtm_* table: RLS on,
-- the owner reads, only the service role writes (the cockpit checks the owner claim, then writes with the secret key).

create table public.gtm_outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  batch text not null check (batch ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  domain text not null check (length(domain) <= 253 and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  -- The model trial's label ("main" outside a trial); model names carry slashes ("deepseek/deepseek-v3.2").
  variant text not null default 'main' check (variant ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'),
  -- {first_name, last_name, title, company, email, linkedin_url, country, lane, score, twenty_person_id}
  prospect jsonb not null default '{}' check (jsonb_typeof(prospect) = 'object'),
  -- {what, date, url}
  trigger jsonb not null default '{}' check (jsonb_typeof(trigger) = 'object'),
  -- {problem, proof, why_now, door, asset}
  strategy jsonb not null default '{}' check (jsonb_typeof(strategy) = 'object'),
  subject text not null default '' check (length(subject) <= 300),
  body text not null default '' check (length(body) <= 20000),
  original_subject text not null default '' check (length(original_subject) <= 300),
  original_body text not null default '' check (length(original_body) <= 20000),
  linkedin_note text not null default '' check (length(linkedin_note) <= 300),
  -- [{day, subject, body, topic}]
  followups jsonb not null default '[]' check (jsonb_typeof(followups) = 'array'),
  -- [{claim, source_url, quote}]
  claims jsonb not null default '[]' check (jsonb_typeof(claims) = 'array'),
  -- [{level: 'block'|'advice', code, detail}]: advisory in /outreach, never blocking Accept.
  findings jsonb not null default '[]' check (jsonb_typeof(findings) = 'array'),
  model text not null default '' check (length(model) <= 200),
  version integer not null default 1 check (version > 0),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'regenerate')),
  -- John's note: what to change (regenerate) or why not (reject).
  note text not null default '' check (length(note) <= 5000),
  decided_by text check (decided_by is null or length(decided_by) <= 200),
  decided_at timestamptz,
  -- Set when a person edits the text in /outreach; the pipeline never overwrites an edited pending draft.
  edited_by text check (edited_by is null or length(edited_by) <= 200),
  edited_at timestamptz,
  linkedin_status text not null default 'none' check (linkedin_status in ('none', 'queued', 'sent', 'connected', 'skipped')),
  email_status text not null default 'none' check (email_status in ('none', 'queued', 'sent', 'replied')),
  constraint gtm_outreach_drafts_key unique (batch, domain, variant),
  constraint gtm_outreach_drafts_acted_only_when_accepted check (status = 'accepted' or (linkedin_status = 'none' and email_status = 'none'))
);
-- One accepted variant per prospect.
create unique index gtm_outreach_drafts_one_accepted on public.gtm_outreach_drafts (batch, domain) where status = 'accepted';
create index gtm_outreach_drafts_batch_idx on public.gtm_outreach_drafts (batch, status);
create index gtm_outreach_drafts_status_idx on public.gtm_outreach_drafts (status, updated_at desc);

create table public.gtm_outreach_draft_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  draft_id uuid not null references public.gtm_outreach_drafts (id) on delete cascade,
  -- The draft's version when this text was current.
  version integer not null check (version > 0),
  reason text not null check (reason in ('edited', 'regenerated', 'reimported')),
  subject text not null,
  body text not null,
  linkedin_note text not null,
  followups jsonb not null,
  -- The draft's status and John's note when this text was replaced (a regenerate keeps his note here).
  status text not null,
  note text not null default '',
  actor text
);
create index gtm_outreach_draft_versions_draft_idx on public.gtm_outreach_draft_versions (draft_id, created_at);

create function public.gtm_outreach_drafts_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.gtm_outreach_drafts_touch() from public, anon, authenticated;
create trigger gtm_outreach_drafts_touch before update on public.gtm_outreach_drafts
  for each row execute function public.gtm_outreach_drafts_touch();

-- Keep the text being replaced. A newer version is the pipeline's regeneration; a new edited_at is a person's edit.
create function public.gtm_outreach_drafts_versioned()
returns trigger language plpgsql set search_path = '' as $$
declare why text;
begin
  if (old.subject, old.body, old.linkedin_note, old.followups) is not distinct from (new.subject, new.body, new.linkedin_note, new.followups) then
    return null;
  end if;
  why := case
    when new.version > old.version then 'regenerated'
    when new.edited_at is distinct from old.edited_at and new.edited_at is not null then 'edited'
    else 'reimported' end;
  insert into public.gtm_outreach_draft_versions (draft_id, version, reason, subject, body, linkedin_note, followups, status, note, actor)
  values (old.id, old.version, why, old.subject, old.body, old.linkedin_note, old.followups, old.status, old.note,
          case when why = 'edited' then new.edited_by else 'pipeline' end);
  return null;
end $$;
revoke all on function public.gtm_outreach_drafts_versioned() from public, anon, authenticated;
create trigger gtm_outreach_drafts_versioned after update on public.gtm_outreach_drafts
  for each row execute function public.gtm_outreach_drafts_versioned();

alter table public.gtm_outreach_drafts enable row level security;
revoke all on public.gtm_outreach_drafts from anon, authenticated;
grant all on public.gtm_outreach_drafts to service_role;
grant select on public.gtm_outreach_drafts to authenticated;
create policy gtm_outreach_drafts_owner_read on public.gtm_outreach_drafts for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

alter table public.gtm_outreach_draft_versions enable row level security;
revoke all on public.gtm_outreach_draft_versions from anon, authenticated;
grant all on public.gtm_outreach_draft_versions to service_role;
grant select on public.gtm_outreach_draft_versions to authenticated;
create policy gtm_outreach_draft_versions_owner_read on public.gtm_outreach_draft_versions for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- Accept one draft, with any edit John made in the same click, and reject its sibling variants ("other variant chosen")
-- in one transaction. Refused when a sibling was already acted on (queued, sent). An accept means he saw it: there is no
-- second confirmation. Service role only: the cockpit checks the owner claim, then calls this with the secret key.
create function public.gtm_outreach_accept(
  p_id uuid, p_actor text,
  p_subject text default null, p_body text default null, p_linkedin_note text default null, p_followups jsonb default null
) returns setof public.gtm_outreach_drafts
language plpgsql security invoker set search_path = '' as $$
declare d public.gtm_outreach_drafts; changed boolean;
begin
  select * into d from public.gtm_outreach_drafts where id = p_id for update;
  if not found then raise exception 'no outreach draft %', p_id using errcode = 'no_data_found'; end if;
  perform 1 from public.gtm_outreach_drafts s
    where s.batch = d.batch and s.domain = d.domain and s.id <> d.id for update;
  if exists (select 1 from public.gtm_outreach_drafts s
              where s.batch = d.batch and s.domain = d.domain and s.id <> d.id
                and (s.linkedin_status <> 'none' or s.email_status <> 'none')) then
    raise exception 'another variant for % was already acted on', d.domain using errcode = 'check_violation';
  end if;
  update public.gtm_outreach_drafts s
     set status = 'rejected', note = 'other variant chosen', decided_by = p_actor, decided_at = now()
   where s.batch = d.batch and s.domain = d.domain and s.id <> d.id and s.status <> 'rejected';
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
