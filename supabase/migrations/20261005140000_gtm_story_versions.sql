-- Asset versions for Stories. Every time a Story asset changes (new media bytes, edited copy) the
-- review page keeps the earlier version so the owner can compare them and see which one an approval or a
-- note is about. Labels run v1, v1.1, v1.2 ... per asset. Media objects are hash-named in the private
-- bucket and never deleted, so a version row only has to record the pointers.

create table public.gtm_story_asset_versions (
  asset_id text not null references public.gtm_story_assets (id) on delete cascade,
  revision bigint not null check (revision > 0),
  label text not null check (label ~ '^v[0-9]+(\.[0-9]+)?$'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  kind text not null check (kind in ('video', 'image', 'copy', 'link')),
  title text not null,
  source text not null,
  storage_path text,
  poster_path text,
  body text,
  created_at timestamptz not null default now(),
  primary key (asset_id, revision)
);
create index gtm_story_asset_versions_asset_idx on public.gtm_story_asset_versions (asset_id, created_at);

alter table public.gtm_story_asset_versions enable row level security;
revoke all on public.gtm_story_asset_versions from anon, authenticated;
grant all on public.gtm_story_asset_versions to service_role;
grant select on public.gtm_story_asset_versions to authenticated;
create policy gtm_story_asset_versions_owner_read on public.gtm_story_asset_versions for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- Written by the same role that changes the asset (the service role), after the revision trigger has
-- bumped the revision. An update that keeps the revision (a poster frame arriving in metadata) refreshes
-- the pointers on the existing row.
create function public.gtm_story_asset_versioned()
returns trigger language plpgsql set search_path = '' as $$
declare existing bigint; next_label text;
begin
  select count(*) into existing from public.gtm_story_asset_versions v where v.asset_id = new.id;
  next_label := case when existing = 0 then 'v1' else 'v1.' || existing end;
  insert into public.gtm_story_asset_versions
    (asset_id, revision, label, sha256, kind, title, source, storage_path, poster_path, body)
  values
    (new.id, new.revision, next_label, new.sha256, new.kind, new.title, new.source, new.storage_path,
     new.metadata ->> 'poster_path', new.body)
  on conflict (asset_id, revision) do update
    set sha256 = excluded.sha256, title = excluded.title, source = excluded.source,
        storage_path = excluded.storage_path, poster_path = excluded.poster_path, body = excluded.body;
  return null;
end $$;
create trigger gtm_story_asset_versioned after insert or update on public.gtm_story_assets
  for each row execute function public.gtm_story_asset_versioned();
revoke all on function public.gtm_story_asset_versioned() from public, anon, authenticated;

-- Current assets become v1.
insert into public.gtm_story_asset_versions (asset_id, revision, label, sha256, kind, title, source, storage_path, poster_path, body)
select a.id, a.revision, 'v1', a.sha256, a.kind, a.title, a.source, a.storage_path, a.metadata ->> 'poster_path', a.body
  from public.gtm_story_assets a
on conflict do nothing;

-- A note says which version of the asset it was written about.
alter table public.gtm_story_feedback add column revision bigint;
update public.gtm_story_feedback f set revision = a.revision from public.gtm_story_assets a where a.id = f.asset_id;

create or replace function public.gtm_add_story_feedback(p_asset_id text, p_channel text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid; current_revision bigint;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can leave Story feedback' using errcode = 'insufficient_privilege';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 5000 then
    raise exception 'invalid Story feedback' using errcode = 'invalid_parameter_value';
  end if;
  select a.revision into current_revision from public.gtm_story_assets a where a.id = p_asset_id;
  if current_revision is null then raise exception 'Story asset not found'; end if;
  insert into public.gtm_story_feedback (asset_id, channel, body, revision)
    values (p_asset_id, p_channel, p_body, current_revision)
    returning id into new_id;
  return new_id;
end $$;
