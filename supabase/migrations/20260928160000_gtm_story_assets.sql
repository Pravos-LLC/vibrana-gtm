-- A Story groups the assets behind independently reviewed channel posts.
-- Publishing intent remains in john-workspace/calendar.yaml; these rows hold
-- reviewable asset snapshots and owner decisions. This migration follows the
-- content-review bucket migration, which supplies private media storage.

create table public.gtm_stories (
  id text primary key,
  title text not null,
  link_url text not null check (link_url ~ '^https://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.gtm_story_assets (
  id text primary key,
  story_id text not null references public.gtm_stories (id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('video', 'image', 'copy', 'link')),
  source text not null, -- calendar-relative file path or HTTPS URL
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint not null default 1 check (revision > 0),
  storage_path text, -- private content-review bucket, for video/image
  body text, -- snapshot of a copy file for review
  url text, -- live link asset
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  constraint gtm_story_assets_payload check (
    (kind in ('video', 'image') and storage_path is not null and body is null and url is null)
    or (kind = 'copy' and body is not null and storage_path is null and url is null)
    or (kind = 'link' and url ~ '^https://' and storage_path is null and body is null)
  )
);
create index gtm_story_assets_story_idx on public.gtm_story_assets (story_id);

create table public.gtm_story_asset_channels (
  asset_id text not null references public.gtm_story_assets (id) on delete cascade,
  channel text not null check (channel ~ '^[a-z][a-z0-9_]*$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  note text not null default '' check (length(note) <= 5000),
  approved_sha256 text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (asset_id, channel),
  constraint gtm_story_approval_hash check (
    (status = 'approved' and approved_sha256 is not null and reviewed_at is not null)
    or (status <> 'approved' and approved_sha256 is null)
  )
);
create index gtm_story_asset_channels_status_idx on public.gtm_story_asset_channels (channel, status);

alter table public.gtm_content_items
  add column story_id text references public.gtm_stories (id) on delete set null;
create index gtm_content_items_story_idx on public.gtm_content_items (story_id);

-- A changed asset cannot keep an approval for its previous bytes or text.
create function public.gtm_story_asset_changed()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.revision := old.revision;
  if new.sha256 is distinct from old.sha256
     or new.source is distinct from old.source
     or new.title is distinct from old.title
     or new.kind is distinct from old.kind
     or new.storage_path is distinct from old.storage_path
     or new.body is distinct from old.body
     or new.url is distinct from old.url then
    new.revision := old.revision + 1;
    update public.gtm_story_asset_channels
       set status = 'pending', approved_sha256 = null, reviewed_by = null,
           reviewed_at = null, note = '', updated_at = now()
     where asset_id = old.id;
  end if;
  return new;
end $$;
create trigger gtm_story_asset_changed before update on public.gtm_story_assets
  for each row execute function public.gtm_story_asset_changed();

-- Only a signed-in owner can record an approval. The approved digest is always
-- copied from the asset row by the database, never accepted from a browser.
create function public.gtm_story_approval_guard()
returns trigger language plpgsql set search_path = '' as $$
declare digest text;
begin
  if tg_op = 'UPDATE' then
    if new.asset_id is distinct from old.asset_id or new.channel is distinct from old.channel then
      raise exception 'asset and channel cannot change';
    end if;
  end if;
  new.updated_at := now();
  if new.status = 'approved' then
    if (select auth.uid()) is null then
      raise exception 'approval requires a signed-in owner' using errcode = 'insufficient_privilege';
    end if;
    select a.sha256 into digest from public.gtm_story_assets a where a.id = new.asset_id;
    if digest is null then raise exception 'asset is missing'; end if;
    new.approved_sha256 := digest;
    new.reviewed_by := (select auth.uid());
    new.reviewed_at := now();
  elsif new.status = 'rejected' then
    new.approved_sha256 := null;
    new.reviewed_by := (select auth.uid());
    new.reviewed_at := now();
  else
    new.approved_sha256 := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  return new;
end $$;
create trigger gtm_story_approval_guard before insert or update on public.gtm_story_asset_channels
  for each row execute function public.gtm_story_approval_guard();

-- The existing owner claim is server-set app_metadata, never user_metadata.
do $$
declare t text;
begin
  foreach t in array array['gtm_stories', 'gtm_story_assets', 'gtm_story_asset_channels'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$,
      t || '_owner_read', t);
  end loop;
end $$;

-- A browser sends the digest it displayed. Locking the asset serializes the
-- decision with staging, so a stale page cannot approve an unseen revision.
create function public.gtm_decide_story_asset(
  p_asset_id text, p_channel text, p_status text, p_note text,
  p_expected_sha256 text, p_expected_revision bigint
) returns void language plpgsql security definer set search_path = '' as $$
declare current_sha256 text; current_revision bigint;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can review Story assets' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('pending', 'approved', 'rejected') or
     p_note is null or length(p_note) > 5000 or
     (p_status = 'rejected' and btrim(p_note) = '') then
    raise exception 'invalid Story decision' using errcode = 'invalid_parameter_value';
  end if;
  select a.sha256, a.revision into current_sha256, current_revision
    from public.gtm_story_assets a where a.id = p_asset_id for update;
  if current_sha256 is null then raise exception 'Story asset not found'; end if;
  if current_sha256 is distinct from p_expected_sha256 or current_revision is distinct from p_expected_revision then
    raise exception 'Story asset changed; refresh and review the new version' using errcode = 'serialization_failure';
  end if;
  update public.gtm_story_asset_channels
     set status = p_status, note = case when p_status = 'pending' then '' else p_note end
   where asset_id = p_asset_id and channel = p_channel;
  if not found then raise exception 'Story channel assignment not found'; end if;
end $$;
revoke all on function public.gtm_decide_story_asset(text, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.gtm_decide_story_asset(text, text, text, text, text, bigint) to authenticated;

revoke all on function public.gtm_story_asset_changed() from public, anon, authenticated;
revoke all on function public.gtm_story_approval_guard() from public, anon, authenticated;
