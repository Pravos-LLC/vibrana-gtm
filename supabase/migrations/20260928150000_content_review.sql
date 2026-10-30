-- Content review suite (products/gtm-cockpit /review): frame.io-style review of AI-generated content.
-- Spec: Linear VIB-394. A batch (one review round of a content series) holds assets (videos, images).
-- The owner leaves comments pinned to a video timecode, then submits the batch once; submitting
-- locks every comment in it at the database level, for every role.
--
-- Access model (same claim as 20260928120000_gtm_cockpit.sql):
--   * Only users whose server-set app_metadata carries gtm_owner=true can read anything.
--   * The owner can write comments, but only while the batch is open.
--   * The owner can move a batch open -> submitted (submit_review), and nothing else.
--   * Batches and assets are created by the gtm CLI with the secret key (service_role).
--   * Media lives in the private bucket content-review, served via short-lived signed URLs.
-- No SECURITY DEFINER functions in public: every rule is RLS, a grant or a trigger.

create table if not exists public.review_batches (
  id uuid primary key default gen_random_uuid(),
  series text not null,                 -- content series, e.g. 'coherence-clips-2026-09'
  round int not null,
  title text not null,
  workspace_dir text not null,          -- john-workspace-relative series folder; `gtm review pull` writes here
  status text not null default 'open' check (status in ('open', 'submitted', 'actioned')),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  actioned_at timestamptz,
  unique (series, round)
);
-- One review round at a time, across all series.
create unique index if not exists review_batches_one_open on public.review_batches ((true)) where status = 'open';

create table if not exists public.review_assets (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batches (id) on delete cascade,
  position int not null,
  slug text not null,
  title text not null,
  kind text not null check (kind in ('video', 'image')),
  storage_path text not null,           -- <series>/r<round>/<position>-<slug>.<ext>
  poster_path text,
  duration_s numeric,                   -- null for images
  version int not null default 1,
  meta jsonb not null default '{}',     -- fps, width, height, bytes, source file, hook
  created_at timestamptz not null default now(),
  unique (batch_id, position),
  unique (batch_id, slug),
  unique (id, batch_id)                 -- target for the composite FK on comments
);

create table if not exists public.review_comments (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  asset_id uuid not null,
  t_ms int check (t_ms is null or t_ms >= 0),  -- null = general note on the asset
  body text not null check (length(btrim(body)) between 1 and 5000),
  author uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- a comment cannot claim a batch its asset does not belong to, so the lock cannot be sidestepped
  foreign key (asset_id, batch_id) references public.review_assets (id, batch_id) on delete cascade
);
create index if not exists review_comments_asset_idx on public.review_comments (asset_id, t_ms);
create index if not exists review_comments_batch_idx on public.review_comments (batch_id);

-- Comments: batch_id defaults to the asset's batch when omitted (the UI never sends it), asset and batch
-- are immutable, updated_at is maintained, and nothing changes once the batch is no longer open.
-- The lock applies to every role, service_role included.
create or replace function public.review_comments_lock()
returns trigger language plpgsql set search_path = '' as $$
declare b_status text;
begin
  if tg_op = 'INSERT' and new.batch_id is null then
    select a.batch_id into new.batch_id from public.review_assets a where a.id = new.asset_id;
    if new.batch_id is null then raise exception 'review_comments: unknown asset %', new.asset_id; end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.batch_id is distinct from old.batch_id or new.asset_id is distinct from old.asset_id then
      raise exception 'review_comments: asset_id and batch_id cannot change';
    end if;
    new.created_at := old.created_at; new.author := old.author; new.updated_at := now();
  end if;
  select b.status into b_status from public.review_batches b
   where b.id = case when tg_op = 'DELETE' then old.batch_id else new.batch_id end
   for share;
  if b_status is distinct from 'open' then
    raise exception 'review batch is %: comments are locked', coalesce(b_status, 'missing') using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists review_comments_lock on public.review_comments;
create trigger review_comments_lock before insert or update or delete on public.review_comments
  for each row execute function public.review_comments_lock();

-- Batches: status only moves forward (open -> submitted -> actioned); timestamps follow.
create or replace function public.review_batches_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if not ((old.status = 'open' and new.status = 'submitted') or (old.status = 'submitted' and new.status = 'actioned')) then
      raise exception 'review batch cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'submitted' then new.submitted_at := now(); end if;
    if new.status = 'actioned' then new.actioned_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists review_batches_guard on public.review_batches;
create trigger review_batches_guard before update on public.review_batches
  for each row execute function public.review_batches_guard();

-- Grants + RLS.
do $$
declare t text;
begin
  foreach t in array array['review_batches', 'review_assets', 'review_comments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$, t || '_owner_read', t);
  end loop;
end $$;

-- Owner comment writes: column-limited, owner claim + open batch in the policy, the lock trigger as backstop.
grant insert (id, asset_id, t_ms, body), update (t_ms, body), delete on public.review_comments to authenticated;
drop policy if exists review_comments_owner_insert on public.review_comments;
create policy review_comments_owner_insert on public.review_comments for insert to authenticated
  with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false)
              and exists (select 1 from public.review_batches b where b.id = batch_id and b.status = 'open'));
drop policy if exists review_comments_owner_update on public.review_comments;
create policy review_comments_owner_update on public.review_comments for update to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false)
         and exists (select 1 from public.review_batches b where b.id = batch_id and b.status = 'open'))
  with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
drop policy if exists review_comments_owner_delete on public.review_comments;
create policy review_comments_owner_delete on public.review_comments for delete to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false)
         and exists (select 1 from public.review_batches b where b.id = batch_id and b.status = 'open'));

-- Submitting: the owner may only move an open batch to submitted (column-limited update; the guard
-- trigger enforces the transition). submit_review is SECURITY INVOKER, so RLS still decides.
grant update (status) on public.review_batches to authenticated;
drop policy if exists review_batches_owner_submit on public.review_batches;
create policy review_batches_owner_submit on public.review_batches for update to authenticated
  using (status = 'open' and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))
  with check (status = 'submitted' and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

drop function if exists public.submit_review(uuid);
create function public.submit_review(p_batch_id uuid)
returns public.review_batches language plpgsql security invoker set search_path = '' as $$
declare r public.review_batches;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'submit_review: owner only' using errcode = 'insufficient_privilege';
  end if;
  update public.review_batches set status = 'submitted' where id = p_batch_id and status = 'open' returning * into r;
  if r.id is null then
    raise exception 'submit_review: batch % is not open', p_batch_id using errcode = 'check_violation';
  end if;
  return r;
end $$;
revoke all on function public.submit_review(uuid) from public, anon;
grant execute on function public.submit_review(uuid) to authenticated, service_role;
revoke all on function public.review_comments_lock() from public, anon, authenticated;
revoke all on function public.review_batches_guard() from public, anon, authenticated;

-- Private media bucket (50 MiB per object; the CLI re-encodes a review proxy for anything larger).
-- Objects are written by the CLI (service role). The owner can read, which is what lets the cockpit
-- mint signed URLs with the session client; nobody else can read or list.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('content-review', 'content-review', false, 52428800, array['video/mp4', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists content_review_owner_read on storage.objects;
create policy content_review_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'content-review'
         and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- A private reservation serializes publishers without exposing an empty review round.
-- Uploads happen outside a transaction; finalization and cancellation lock this same row.
create table if not exists public.review_publications (
  id uuid primary key,
  singleton boolean not null default true unique check (singleton),
  series text not null,
  round int not null,
  title text not null,
  workspace_dir text not null,
  created_at timestamptz not null default now()
);
alter table public.review_publications enable row level security;
revoke all on public.review_publications from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.review_publications to service_role;

-- Cancellation tombstones prevent an ambiguous, delayed reserve request from resurrecting
-- a cancelled attempt. An attempt-level advisory lock also serializes uncommitted inserts.
create table if not exists public.review_publication_cancellations (
  id uuid primary key,
  created_at timestamptz not null default now()
);
alter table public.review_publication_cancellations enable row level security;
revoke all on public.review_publication_cancellations from public, anon, authenticated, service_role;
grant select, insert on public.review_publication_cancellations to service_role;

create or replace function public.reserve_review_publication(
  p_id uuid, p_series text, p_round int, p_title text, p_workspace_dir text
) returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text, 0));
  if exists (select 1 from public.review_publication_cancellations where id = p_id) then
    raise exception 'Publication attempt was cancelled';
  end if;
  insert into public.review_publications (id, series, round, title, workspace_dir)
    values (p_id, p_series, p_round, p_title, p_workspace_dir);
  if exists (select 1 from public.review_batches where status = 'open') then
    raise exception 'A review round is still open';
  end if;
  if exists (select 1 from public.review_batches where series = p_series and round = p_round) then
    raise exception 'This series and round have already been published';
  end if;
  return p_id;
end $$;

create or replace function public.finalize_review_publication(p_id uuid, p_assets jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare p public.review_publications; actioned jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text, 0));
  select * into p from public.review_publications where id = p_id for update;
  if p.id is null then raise exception 'Publication reservation is missing or cancelled'; end if;
  if jsonb_typeof(p_assets) is distinct from 'array' or jsonb_array_length(p_assets) = 0 then
    raise exception 'Publication requires assets';
  end if;
  insert into public.review_batches (id, series, round, title, workspace_dir)
    values (p.id, p.series, p.round, p.title, p.workspace_dir);
  insert into public.review_assets
    (batch_id, position, slug, title, kind, storage_path, poster_path, duration_s, meta)
    select p.id, a.position, a.slug, a.title, a.kind, a.storage_path, a.poster_path, a.duration_s, coalesce(a.meta, '{}')
    from jsonb_to_recordset(p_assets) as a(position int, slug text, title text, kind text,
      storage_path text, poster_path text, duration_s numeric, meta jsonb);
  -- Every path must belong to this attempt, so rollback cleanup cannot touch older media.
  if exists (select 1 from public.review_assets where batch_id = p.id
    and (storage_path not like p.id::text || '/%'
      or (poster_path is not null and poster_path not like p.id::text || '/%'))) then
    raise exception 'Asset paths must belong to the publication';
  end if;
  with changed as (
    update public.review_batches set status = 'actioned'
    where series = p.series and status = 'submitted' and round < p.round returning round
  ) select coalesce(jsonb_agg(round), '[]') into actioned from changed;
  delete from public.review_publications where id = p_id;
  return jsonb_build_object('batch', p.id, 'actioned', actioned);
end $$;

-- Returns true ONLY when storage compensation is safe. This also handles a lost commit
-- response: cancellation waits for finalization, and a committed batch preserves its media.
create or replace function public.cancel_review_publication(p_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text, 0));
  perform 1 from public.review_publications where id = p_id for update;
  if exists (select 1 from public.review_batches where id = p_id) then return false; end if;
  insert into public.review_publication_cancellations(id) values (p_id) on conflict do nothing;
  delete from public.review_publications where id = p_id;
  return true;
end $$;
revoke all on function public.reserve_review_publication(uuid, text, int, text, text) from public, anon, authenticated;
revoke all on function public.finalize_review_publication(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.cancel_review_publication(uuid) from public, anon, authenticated;
grant execute on function public.reserve_review_publication(uuid, text, int, text, text) to service_role;
grant execute on function public.finalize_review_publication(uuid, jsonb) to service_role;
grant execute on function public.cancel_review_publication(uuid) to service_role;
