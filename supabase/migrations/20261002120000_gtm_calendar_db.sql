-- The GTM content calendar moves into the database.
--
-- Until now the source of truth was john-workspace/2-work/content-engine/calendar.yaml,
-- read from John's disk by vibrana-gtm, so the deployed dashboard could not plan or
-- publish anything. From this migration on, public.gtm_content_items is the source of
-- truth: it carries the post body, media (content-review storage paths or HTTPS URLs),
-- the Substack publication and the approval digest. calendar.yaml becomes an
-- import/export format (`gtm calendar import|export`), never read at publish time.
--
-- gtm_inspiration is a small reference library (videos, carousels, newsletters, posts
-- we want to learn from), read by the owner in the dashboard and written by the
-- server/CLI with the secret key, like every other gtm_* table.

-- ---- gtm_content_items: calendar columns -------------------------------------------

alter table public.gtm_content_items
  add column publication text
    constraint gtm_content_items_publication check (publication in ('sample_author', 'regenera')),
  add column body text,
  add column media jsonb not null default '[]'
    constraint gtm_content_items_media_array check (jsonb_typeof(media) = 'array'),
  add column approved_hash text
    constraint gtm_content_items_approved_hash check (approved_hash ~ '^[a-f0-9]{64}$'),
  add column story_assets text[] not null default '{}',
  add column copy_path text, -- legacy calendar.yaml copy path, provenance only
  add column created_at timestamptz not null default now();

-- Live rows carry times written as YAML-escaped strings (`\"15:00\"`), which parsed to
-- an invalid date and silently disabled the too-soon publishing guard. Normalize them
-- to bare HH:MM before the constraint makes the bad shape impossible.
update public.gtm_content_items
   set time = nullif(regexp_replace(time, '[^0-9:]', '', 'g'), '')
 where time is not null and time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';

-- One live row predates the four-pillar content strategy: the 2 Oct 2026 reintroduction
-- post, filed under the legacy pillar 'story'. Its subject (keeping our humanity as AI grows)
-- is the Perspective pillar's human dimension, so it moves there before the pillar check
-- applies. Any other out-of-set value still fails the migration loudly.
update public.gtm_content_items set pillar = 'perspective' where pillar = 'story';

alter table public.gtm_content_items
  add constraint gtm_content_items_time
    check (time is null or time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add constraint gtm_content_items_pillar
    check (pillar in ('proof', 'perspective', 'build', 'lists')),
  add constraint gtm_content_items_status
    check (status in ('idea', 'drafted', 'approved', 'scheduled', 'published', 'failed', 'skipped'));

-- Approval is bound to the exact body and media it was given for. Editing either
-- clears it, unless the same statement records a new digest (an explicit re-approval
-- or an import of an already-approved item).
create function public.gtm_content_item_changed()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if (new.body is distinct from old.body or new.media is distinct from old.media)
     and new.approved_hash is not distinct from old.approved_hash then
    new.approved_hash := null;
    if new.status = 'approved' then
      new.status := 'drafted';
    end if;
  end if;
  return new;
end $$;
create trigger gtm_content_item_changed before update on public.gtm_content_items
  for each row execute function public.gtm_content_item_changed();
revoke all on function public.gtm_content_item_changed() from public, anon, authenticated;

-- ---- gtm_inspiration ---------------------------------------------------------------

create table public.gtm_inspiration (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('video', 'carousel', 'newsletter', 'post')),
  url text not null unique check (url ~ '^https?://'),
  title text not null default '',
  platform text,
  tags text[] not null default '{}',
  why_we_like text not null default '',
  thumbnail_path text,
  pillar text check (pillar in ('proof', 'perspective', 'build', 'lists')),
  added_by text,
  created_at timestamptz not null default now()
);
create index gtm_inspiration_created_idx on public.gtm_inspiration (created_at desc);
create index gtm_inspiration_tags_idx on public.gtm_inspiration using gin (tags);

-- Same owner-read model as the Story tables: the server-set app_metadata claim.
do $$
declare t text;
begin
  foreach t in array array['gtm_inspiration'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false))$p$,
      t || '_owner_read', t);
  end loop;
end $$;
