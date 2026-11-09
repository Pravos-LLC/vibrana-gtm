-- CRM people mirror (VIB-516): the GTM cockpit's copy of every Twenty person, so the cockpit works on the whole CRM
-- (14k people in 2026-11, growing) without re-reading Twenty every hour. Production Twenty is one small Postgres that
-- saturated under repeated people reads on 2026-10-01; the cockpit's mirror job (vibrana-gtm lib/crm/mirror.ts, hourly at
-- :05) reads only what changed since its cursor, paced, and upserts here.
--
-- Ids, dates and status flags only: no person's name, email address, phone, job title or note text is ever stored.
-- `has_email` is a flag, never the address. The creator's Twenty display name or API key name (created_by_name) is kept,
-- because team attribution is by member or key name.
--
-- 1. gtm_crm_people: one row per Twenty person, soft deletes kept as deleted_at (Twenty soft-deletes; an erasure that
--    destroys the row is caught by the job's count check and id sweep, which sets deleted_at here too).
-- 2. gtm_team_people_summary(): what the team page needs about the people a member created, as counts plus one
--    creation time (epoch milliseconds) per person added since p_since. Its size grows with a member's recent
--    additions, not the CRM.
-- 3. gtm_team_people_lookup(): of the given person ids, the ones the member created, with when. Called with the few
--    people a member emailed or that are opportunity contacts, never with the whole CRM.
--
-- "Created by a member" matches the Twenty filter the cockpit used before (lib/team/members.ts createdByFilter): the
-- member's Twenty workspace member id, or an API key name listed for them.

create table public.gtm_crm_people (
  id uuid primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  created_by_source text check (created_by_source is null or length(created_by_source) <= 40),
  created_by_name text check (created_by_name is null or length(created_by_name) <= 200),
  created_by_member uuid,
  has_email boolean not null default false,
  email_verification text check (email_verification is null or length(email_verification) <= 40),
  not_sendable boolean not null default false,
  company_id uuid,
  last_contacted_at timestamptz,
  mirrored_at timestamptz not null default now()
);
create index gtm_crm_people_member_created_idx on public.gtm_crm_people (created_by_member, created_at) where deleted_at is null;
create index gtm_crm_people_name_created_idx on public.gtm_crm_people (created_by_name, created_at) where deleted_at is null;

-- ---- access: the owner reads, the service role writes -----------------------------------------------------------

alter table public.gtm_crm_people enable row level security;
revoke all on public.gtm_crm_people from anon, authenticated;
grant all on public.gtm_crm_people to service_role;
grant select on public.gtm_crm_people to authenticated;
create policy gtm_crm_people_owner_read on public.gtm_crm_people for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- ---- 2. the team summary ----------------------------------------------------------------------------------------

create function public.gtm_team_people_summary(p_member uuid, p_keys text[], p_since timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  with mine as (
    select p.id, p.created_at, p.has_email, p.email_verification, p.not_sendable
    from public.gtm_crm_people p
    where p.deleted_at is null
      and ((p_member is not null and p.created_by_member = p_member)
        or (p.created_by_name is not null and p.created_by_name = any(coalesce(p_keys, '{}'::text[]))))
  )
  select jsonb_build_object(
    'total', (select count(*) from mine),
    'withEmail', (select count(*) from mine where has_email),
    'verified', (select count(*) from mine where has_email and email_verification = 'VERIFIED'),
    'sendable', (select count(*) from mine where has_email and email_verification = 'VERIFIED' and not not_sendable),
    'unverified', (select count(*) from mine where email_verification is distinct from 'VERIFIED'),
    'addedSince', to_char(p_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'added', coalesce((select jsonb_agg(floor(extract(epoch from created_at) * 1000)::bigint order by created_at)
                        from mine where created_at >= p_since), '[]'::jsonb),
    'latest', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'createdAt', created_at) order by created_at desc, id)
                         from (select id, created_at from mine order by created_at desc, id limit 25) l), '[]'::jsonb)
  );
$$;

create function public.gtm_team_people_lookup(p_member uuid, p_keys text[], p_ids uuid[])
returns table (id uuid, created_at timestamptz) language sql stable set search_path = '' as $$
  select p.id, p.created_at
  from public.gtm_crm_people p
  where p.id = any(coalesce(p_ids, '{}'::uuid[]))
    and p.deleted_at is null
    and ((p_member is not null and p.created_by_member = p_member)
      or (p.created_by_name is not null and p.created_by_name = any(coalesce(p_keys, '{}'::text[]))));
$$;

revoke all on function public.gtm_team_people_summary(uuid, text[], timestamptz), public.gtm_team_people_lookup(uuid, text[], uuid[])
  from public, anon, authenticated;
grant execute on function public.gtm_team_people_summary(uuid, text[], timestamptz), public.gtm_team_people_lookup(uuid, text[], uuid[])
  to service_role;
