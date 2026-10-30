-- One writing desk, two streams (VIB-463). The desk (20261017010000_gtm_outreach_desk.sql) served one stream: cold client
-- prospects, sent from user-045d73df3c9a@example.com, one global daily target of 5. John now also invites podcast guests, from
-- user-8dd8662c2f5a@example.com, 2 a day. Same screen, two tracks, each with its own sender, daily target and profile.
--
-- 1. gtm_outreach_tracks: one row per track ('client', 'guest'): from_address, daily_target, profile (signature, facts, assets,
--    voice, gold examples). 'client' is seeded from the existing gtm_outreach_desk row, so today's target and profile carry over.
--    gtm_outreach_desk stays, unused, until a later cleanup.
-- 2. track on gtm_outreach_dossiers and gtm_outreach_drafts, default 'client': every existing row is a client row.
-- 3. gtm_outreach_drafts.route (email, linkedin or intermediary): how a guest is reached. Any route counts toward the target.
--    follow_up_status / follow_up_sent_at: the single follow-up (a guest gets one, 7 to 10 days later, same thread). A follow-up
--    never counts toward the daily target, so it is stamped separately from email_sent_at.
--
-- Additive and defaulted: the client desk behaves exactly as before if the cockpit lags this migration.
-- Like every gtm_* table: RLS on, the owner reads, only the service role writes.

-- ---- 1. tracks ----------------------------------------------------------------------------------------------------------
create table public.gtm_outreach_tracks (
  track text primary key check (track in ('client', 'guest')),
  updated_at timestamptz not null default now(),
  updated_by text check (updated_by is null or length(updated_by) <= 200),
  daily_target integer not null check (daily_target between 1 and 200),
  from_address text not null check (length(from_address) <= 254 and from_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  profile jsonb not null default '{}' check (jsonb_typeof(profile) = 'object' and octet_length(profile::text) <= 500000),
  profile_imported_at timestamptz
);
insert into public.gtm_outreach_tracks (track, daily_target, from_address, profile, profile_imported_at)
  select 'client', d.daily_target, 'user-045d73df3c9a@example.com', d.profile, d.profile_imported_at from public.gtm_outreach_desk d;
insert into public.gtm_outreach_tracks (track, daily_target, from_address)
  values ('guest', 2, 'user-8dd8662c2f5a@example.com');
create trigger gtm_outreach_tracks_touch before update on public.gtm_outreach_tracks
  for each row execute function public.gtm_outreach_drafts_touch();

alter table public.gtm_outreach_tracks enable row level security;
revoke all on public.gtm_outreach_tracks from anon, authenticated;
grant all on public.gtm_outreach_tracks to service_role;
grant select on public.gtm_outreach_tracks to authenticated;
create policy gtm_outreach_tracks_owner_read on public.gtm_outreach_tracks for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- ---- 2. the track on dossiers and drafts --------------------------------------------------------------------------------
alter table public.gtm_outreach_dossiers
  add column track text not null default 'client' check (track in ('client', 'guest'));
alter table public.gtm_outreach_drafts
  add column track text not null default 'client' check (track in ('client', 'guest'));
create index gtm_outreach_dossiers_track_idx on public.gtm_outreach_dossiers (track, score desc nulls last, name);
create index gtm_outreach_drafts_track_idx on public.gtm_outreach_drafts (track, batch);

-- ---- 3. route and the single follow-up ----------------------------------------------------------------------------------
alter table public.gtm_outreach_drafts
  add column route text not null default 'email' check (route in ('email', 'linkedin', 'intermediary')),
  add column follow_up_status text not null default 'none' check (follow_up_status in ('none', 'sent')),
  add column follow_up_sent_at timestamptz;

create or replace function public.gtm_outreach_drafts_sent_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.email_status in ('sent', 'replied') and new.email_sent_at is null then new.email_sent_at := now(); end if;
  if new.linkedin_status in ('sent', 'connected') and new.linkedin_sent_at is null then new.linkedin_sent_at := now(); end if;
  if new.follow_up_status = 'sent' and new.follow_up_sent_at is null then new.follow_up_sent_at := now(); end if;
  if new.follow_up_status = 'none' then new.follow_up_sent_at := null; end if;
  return new;
end $$;
