-- The network desk's mailbox (VIB-522): the Google account behind the network stream's send-as alias, connected once by the
-- owner from Pipeline > Conversations so the hourly pipeline job can read replies and bounces to network desk emails.
--
-- One row at most (id is always 1). The refresh token is sealed by the cockpit (AES-256-GCM, lib/team/crypto.ts) before it
-- is written, with the address as associated data. The grant must include gmail.readonly (a thread search needs more than
-- metadata); granted_scopes records what Google actually granted. reconnect_needed_at is set when Google refuses the stored
-- grant, so the page asks for a reconnect instead of the job failing quietly every hour; a reconnect replaces the row.
--
-- A table of its own on purpose: the team email sync reads gtm_team_mailboxes, and this account is a personal mailbox
-- that must never be counted as a team member's work mailbox on /performance/team.
--
-- Service role only: RLS on with no policy, and no grant for anon or authenticated. The cockpit reads its status
-- server-side after checking the signed-in owner, so not even the owner's session can read the sealed token.

create table public.gtm_network_mailbox (
  id smallint primary key default 1 check (id = 1),
  address text not null check (address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and address = lower(address)),
  token_ciphertext text not null check (length(token_ciphertext) between 40 and 4000),
  key_version smallint not null default 1,
  granted_scopes text[] not null default '{}',
  connected_by text not null check (connected_by ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500),
  reconnect_needed_at timestamptz
);

alter table public.gtm_network_mailbox enable row level security;
revoke all on public.gtm_network_mailbox from anon, authenticated;
grant all on public.gtm_network_mailbox to service_role;
