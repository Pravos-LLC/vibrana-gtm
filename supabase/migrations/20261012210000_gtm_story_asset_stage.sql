
alter table public.gtm_story_assets
  add column stage text check (stage ~ '^[a-z][a-z0-9-]{0,39}$');

comment on column public.gtm_story_assets.stage is
  'Pipeline stage of this asset (e.g. rough-cut, final). Null = final/legacy. Only null or final can be scheduled.';

create or replace function public.gtm_story_asset_changed()
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
  elsif old.stage is not null and new.stage is distinct from old.stage then
    update public.gtm_story_asset_channels
       set status = 'pending', approved_sha256 = null, reviewed_by = null,
           reviewed_at = null, note = '', updated_at = now()
     where asset_id = old.id and status = 'approved';
  end if;
  return new;
end $$;
revoke all on function public.gtm_story_asset_changed() from public, anon, authenticated;

update public.gtm_story_assets
   set stage = 'rough-cut'
 where story_id ~ '^s1-(18|19|20|21|22)-example-record-' and kind = 'video' and stage is null;

update public.gtm_stories
   set hold_note = 'example_approver only ever sees final versions, never rough cuts', updated_at = now()
 where id ~ '^s1-(18|19|20|21|22)-example-record-' and held_at is not null;
