
create table public.gtm_seasons (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 5000),
  starts_on date not null,
  ends_on date not null,
  pillars text[] not null default '{}'
    check (pillars <@ array['proof', 'perspective', 'build', 'lists']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_seasons_dates check (ends_on >= starts_on)
);

alter table public.gtm_seasons enable row level security;
revoke all on public.gtm_seasons from anon, authenticated;
grant all on public.gtm_seasons to service_role;
grant select on public.gtm_seasons to authenticated;
create policy gtm_seasons_owner_read on public.gtm_seasons for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

alter table public.gtm_stories add column season_id text references public.gtm_seasons (id);
create index gtm_stories_season_idx on public.gtm_stories (season_id);

create function public.gtm_update_season(
  p_id text, p_title text, p_description text, p_starts_on date, p_ends_on date, p_pillars text[]
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can edit a Season' using errcode = 'insufficient_privilege';
  end if;
  if p_title is null or length(btrim(p_title)) = 0 or length(p_title) > 200
     or p_description is null or length(p_description) > 5000
     or p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_pillars is null
     or not (p_pillars <@ array['proof', 'perspective', 'build', 'lists']::text[]) then
    raise exception 'invalid Season' using errcode = 'invalid_parameter_value';
  end if;
  update public.gtm_seasons
     set title = btrim(p_title), description = p_description, starts_on = p_starts_on, ends_on = p_ends_on,
         pillars = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(p_pillars) x),
         updated_at = now()
   where id = p_id;
  if not found then raise exception 'Season not found'; end if;
end $$;
revoke all on function public.gtm_update_season(text, text, text, date, date, text[]) from public, anon, authenticated;
grant execute on function public.gtm_update_season(text, text, text, date, date, text[]) to authenticated;

insert into public.gtm_seasons (id, title, description, starts_on, ends_on, pillars) values (
 'season-1', 'Example season', 'Synthetic local demonstration season.', date '2027-01-04', date '2027-02-26', array['build', 'lists', 'perspective', 'proof']
) on conflict (id) do nothing;

update public.gtm_stories set season_id = 'season-1' where id like 's1-%' and season_id is null;
