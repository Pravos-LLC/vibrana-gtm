-- People John tags in posts (GTM cockpit, John 2026-10-16: "How do I know when mentioning someone it will actually
-- work?"). He types `@Chetan Nandakumar` once in a piece's one shared text; at publish each platform gets the form that
-- tags there: LinkedIn `@[<exact profile name>](urn:li:person:...)` (resolved once through Zernio from the profile URL and
-- cached here), Instagram `@<handle>`, and plain text where nothing is on file. /content shows, per platform, whether
-- each `@Name` will tag before John approves.
--
-- Public profile links of people John has tagged in public posts. Like every gtm_* table: RLS on, the owner reads, only
-- the service role writes.

create table public.gtm_people (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- What John types after "@": the name without pronouns, credentials or emoji ("Fatma Sample Person").
  name text not null check (length(btrim(name)) between 1 and 120),
  linkedin_url text check (linkedin_url is null or linkedin_url ~ '^https://www\.linkedin\.com/(in|company)/[^/?#\s]+/?$'),
  -- The name exactly as LinkedIn shows it; a person tag is only clickable when it matches.
  linkedin_name text check (linkedin_name is null or length(btrim(linkedin_name)) between 1 and 200),
  linkedin_urn text check (linkedin_urn is null or linkedin_urn ~ '^urn:li:(person|organization):[A-Za-z0-9_-]+$'),
  -- Why the last resolve failed (Zernio cannot resolve some live profiles); empty when it worked or was never tried.
  linkedin_error text not null default '' check (length(linkedin_error) <= 500),
  linkedin_checked_at timestamptz,
  instagram_handle text check (instagram_handle is null or instagram_handle ~ '^[a-z0-9._]{1,30}$'),
  source text not null default '' check (length(source) <= 200)
);
create unique index gtm_people_name_key on public.gtm_people (lower(name));
create unique index gtm_people_linkedin_key on public.gtm_people (lower(linkedin_url)) where linkedin_url is not null;
create unique index gtm_people_instagram_key on public.gtm_people (instagram_handle) where instagram_handle is not null;

create function public.gtm_people_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.gtm_people_touch() from public, anon, authenticated;
create trigger gtm_people_touch before update on public.gtm_people
  for each row execute function public.gtm_people_touch();

alter table public.gtm_people enable row level security;
revoke all on public.gtm_people from anon, authenticated;
grant all on public.gtm_people to service_role;
grant select on public.gtm_people to authenticated;
create policy gtm_people_owner_read on public.gtm_people for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
