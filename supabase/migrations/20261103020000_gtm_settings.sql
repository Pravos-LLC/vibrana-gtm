-- Cockpit settings John edits on screen (John, 2026-11-02: "a much simpler, more sensible system"). The first is the
-- weekly rhythm (posting days, their pillar, the channels each day posts on, the pillars a channel never takes), which
-- used to ship as private guide JSON through a release and six production pins. A change applies at once; every
-- version is kept in gtm_settings_history so a bad edit can be undone.

create table public.gtm_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_.-]{1,60}$'),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table public.gtm_settings_history (
  id bigint generated always as identity primary key,
  key text not null,
  value jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by text
);
create index gtm_settings_history_key_idx on public.gtm_settings_history (key, changed_at desc);

-- Every saved version lands in the history, written by the database so no writer can skip it.
create function public.gtm_settings_log() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.gtm_settings_history (key, value, changed_at, changed_by) values (new.key, new.value, now(), new.updated_by);
  return new;
end $$;
revoke all on function public.gtm_settings_log() from public, anon, authenticated;
create trigger gtm_settings_log after insert or update on public.gtm_settings
  for each row execute function public.gtm_settings_log();

-- ---- access: owner reads, service role writes (the cockpit's server actions check the owner first) -------------

alter table public.gtm_settings enable row level security;
alter table public.gtm_settings_history enable row level security;
revoke all on public.gtm_settings, public.gtm_settings_history from anon, authenticated;
grant select on public.gtm_settings, public.gtm_settings_history to authenticated;
grant all on public.gtm_settings, public.gtm_settings_history to service_role;
create policy gtm_settings_owner_read on public.gtm_settings for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_settings_history_owner_read on public.gtm_settings_history for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
