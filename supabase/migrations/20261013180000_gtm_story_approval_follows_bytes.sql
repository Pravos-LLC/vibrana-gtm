-- A platform approval follows the asset's bytes (sha256), not its storage key, file path or display title.
--
-- Restaging a Story (`gtm story stage`) can move an asset's storage key while its bytes are identical: the key is
-- <id>-<sha16>.<ext>, so a row whose key was written by another path (or under an older naming) moves on the next
-- restage. Until now any change to storage_path, source or title cleared every channel approval, so John's approvals on
-- s1-14 and s1-16 were silently reset on 2026-10-13 and had to be re-recorded by hand.
--
-- Now:
--   * new bytes (sha256), a new body or url, or a new kind: the revision bumps and every approval clears (as before).
--   * same bytes under a new storage key, source path or title: the revision still bumps (a page opened on the old
--     revision cannot decide, gtm_decide_story_asset refuses it with PT409), but an approval whose approved_sha256 is
--     these bytes is kept. Any approval for other bytes (already stale) is cleared.
--   * moving from one stage to another still clears approvals, even on identical bytes (20261012210000: a rough-cut
--     approval is not a final one).
create or replace function public.gtm_story_asset_changed()
returns trigger language plpgsql set search_path = '' as $$
declare stage_moved boolean := old.stage is not null and new.stage is distinct from old.stage;
begin
  new.updated_at := now();
  new.revision := old.revision;
  if new.sha256 is distinct from old.sha256
     or new.kind is distinct from old.kind
     or new.body is distinct from old.body
     or new.url is distinct from old.url then
    new.revision := old.revision + 1;
    update public.gtm_story_asset_channels
       set status = 'pending', approved_sha256 = null, reviewed_by = null,
           reviewed_at = null, note = '', updated_at = now()
     where asset_id = old.id;
  elsif new.source is distinct from old.source
     or new.title is distinct from old.title
     or new.storage_path is distinct from old.storage_path then
    new.revision := old.revision + 1;
    update public.gtm_story_asset_channels
       set status = 'pending', approved_sha256 = null, reviewed_by = null,
           reviewed_at = null, note = '', updated_at = now()
     where asset_id = old.id and status = 'approved'
       and (stage_moved or approved_sha256 is distinct from new.sha256);
  elsif stage_moved then
    update public.gtm_story_asset_channels
       set status = 'pending', approved_sha256 = null, reviewed_by = null,
           reviewed_at = null, note = '', updated_at = now()
     where asset_id = old.id and status = 'approved';
  end if;
  return new;
end $$;
revoke all on function public.gtm_story_asset_changed() from public, anon, authenticated;
