-- Meetings from Google Calendar (VIB-518), the GTM cockpit's meeting source once Granola is retired.
--
-- 1. gtm_team_calendars: a member's own consent to a read-only Google Calendar connection (calendar.readonly). The refresh
--    token is sealed by the cockpit (AES-256-GCM, lib/team/crypto.ts) before it is written; signed-in owners can read the
--    status columns but never the ciphertext (column grants below), only the service role can. A member may connect a
--    calendar on a different address from their mailbox (John's client meetings live on his personal domain's calendar).
-- 2. gtm_calendar_meetings: which Twenty `meeting` row stands for which calendar event, so the hourly sync is idempotent
--    and can withdraw a row it created when the event is cancelled. The event is kept only as a keyed hash of its id; no
--    title, description, location or attendee address is stored, and an event with no attendee the CRM knows is never
--    written at all.

create table public.gtm_team_calendars (
  member text not null check (member ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  address text not null check (address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and address = lower(address)),
  token_ciphertext text not null check (length(token_ciphertext) between 40 and 4000),
  key_version smallint not null default 1,
  granted_scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500),
  last_result jsonb check (last_result is null or jsonb_typeof(last_result) = 'object'),
  primary key (member, address)
);

create table public.gtm_calendar_meetings (
  member text not null check (member ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  event_key text not null check (event_key ~ '^[A-Za-z0-9_-]{32}$'),
  meeting_id uuid not null,
  -- created: the sync made the Twenty row (it may withdraw it); adopted: the row already existed (a Granola or hand-made
  -- row for the same meeting), the sync links to it and never deletes it.
  origin text not null check (origin in ('created', 'adopted')),
  start_at timestamptz not null,
  kind text not null check (kind in ('CLIENT', 'DISCOVERY', 'PARTNER', 'OTHER')),
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (member, event_key)
);
create index gtm_calendar_meetings_meeting_idx on public.gtm_calendar_meetings (meeting_id);

-- ---- access: the owner reads, the service role writes; a calendar token is never readable by a signed-in user -----

alter table public.gtm_team_calendars enable row level security;
alter table public.gtm_calendar_meetings enable row level security;
revoke all on public.gtm_team_calendars, public.gtm_calendar_meetings from anon, authenticated;
grant all on public.gtm_team_calendars, public.gtm_calendar_meetings to service_role;
grant select (member, address, key_version, granted_scopes, connected_at, last_sync_at, last_error, last_result) on public.gtm_team_calendars to authenticated;
grant select on public.gtm_calendar_meetings to authenticated;

create policy gtm_team_calendars_owner_read on public.gtm_team_calendars for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_calendar_meetings_owner_read on public.gtm_calendar_meetings for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
