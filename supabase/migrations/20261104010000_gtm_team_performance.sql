-- Team performance (/performance/team in the GTM cockpit): what a team member does for GTM, measured from the CRM, their
-- mailbox and the writing desk.
--
-- 1. gtm_team_mailboxes: a member's own consent to a read-only, metadata-only Gmail connection. The refresh token is
--    sealed by the cockpit (AES-256-GCM, lib/team/crypto.ts) before it is written; signed-in users can read the
--    connection status columns but never the ciphertext (column grants below), only the service role can.
-- 2. gtm_team_mail_events: one row per counted message: an outreach send to an eligible CRM person, other mail to a CRM
--    company, a reply in an outreach thread, or a bounce. No address, subject, snippet or body is stored; recipients are
--    kept only as keyed hashes so a reply can be matched to the person written to. Mail to anyone outside the CRM is
--    never written at all.
-- 3. gtm_team_stock_daily: the daily state of a member's records (research stages and decisions, sendable contacts,
--    open tasks), which history cannot rebuild later.
-- 4. gtm_outreach_drafts.email_sent_by / linkedin_sent_by: who marked a desk send, so desk sends count per person.

create table public.gtm_team_mailboxes (
  member text not null check (member ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  address text not null check (address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and address = lower(address)),
  token_ciphertext text not null check (length(token_ciphertext) between 40 and 4000),
  key_version smallint not null default 1,
  history_id text check (history_id is null or history_id ~ '^[0-9]{1,30}$'),
  backfill_done boolean not null default false,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500),
  primary key (member, address)
);

create table public.gtm_team_mail_events (
  id bigint generated always as identity primary key,
  member text not null check (member ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  gmail_message_id text not null check (gmail_message_id ~ '^[a-f0-9]{1,64}$'),
  thread_id text not null check (thread_id ~ '^[a-f0-9]{1,64}$'),
  kind text not null check (kind in ('outreach', 'other_crm', 'reply', 'bounce')),
  at timestamptz not null,
  person_ids text[] not null default '{}',
  company_ids text[] not null default '{}',
  recipient_hashes text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint gtm_team_mail_events_once unique (member, gmail_message_id)
);
create index gtm_team_mail_events_member_at_idx on public.gtm_team_mail_events (member, at desc);
create index gtm_team_mail_events_thread_idx on public.gtm_team_mail_events (member, thread_id);

create table public.gtm_team_stock_daily (
  member text not null check (member ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  date date not null,
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  captured_at timestamptz not null default now(),
  primary key (member, date)
);

alter table public.gtm_outreach_drafts
  add column email_sent_by text check (email_sent_by is null or length(email_sent_by) <= 254),
  add column linkedin_sent_by text check (linkedin_sent_by is null or length(linkedin_sent_by) <= 254);

-- ---- access: the owner reads, the service role writes; a mailbox token is never readable by a signed-in user -----

alter table public.gtm_team_mailboxes enable row level security;
alter table public.gtm_team_mail_events enable row level security;
alter table public.gtm_team_stock_daily enable row level security;
revoke all on public.gtm_team_mailboxes, public.gtm_team_mail_events, public.gtm_team_stock_daily from anon, authenticated;
grant all on public.gtm_team_mailboxes, public.gtm_team_mail_events, public.gtm_team_stock_daily to service_role;
grant select (member, address, key_version, backfill_done, connected_at, last_sync_at, last_error) on public.gtm_team_mailboxes to authenticated;
grant select on public.gtm_team_mail_events, public.gtm_team_stock_daily to authenticated;

create policy gtm_team_mailboxes_owner_read on public.gtm_team_mailboxes for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_team_mail_events_owner_read on public.gtm_team_mail_events for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_team_stock_daily_owner_read on public.gtm_team_stock_daily for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
