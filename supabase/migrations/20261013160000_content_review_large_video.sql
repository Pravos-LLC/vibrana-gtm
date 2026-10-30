-- A full podcast episode final (1080p, about an hour, 2.5 to 5 GB) is staged into /content as a Story's video asset.
-- The bucket held 50 MiB, so it refused one. Raise content-review's limit to 5 GiB, which is also what Zernio takes
-- per media upload, so nothing is stored that could never be scheduled. The project-wide storage upload limit is a
-- separate setting (Management API / dashboard) and must be at least this high; privacy and mime types are unchanged.
-- `gtm story stage` uploads files over 50 MiB with the resumable (TUS) endpoint and stages a small 720p review proxy
-- beside the master (metadata.proxy_path); /content and /shared play the proxy, approval binds to the master's sha256.
update storage.buckets
   set file_size_limit = 5368709120
 where id = 'content-review';

-- Versions keep the review proxy too, so an earlier version of a long video plays from its proxy, not the master.
-- Same function as 20261012220000_gtm_story_stages.sql, with proxy_path added to the copied metadata.
create or replace function public.gtm_story_asset_versioned()
returns trigger language plpgsql set search_path = '' as $$
declare existing bigint; next_label text; meta jsonb; what text;
begin
  select count(*) into existing from public.gtm_story_asset_versions v where v.asset_id = new.id;
  next_label := case when existing = 0 then 'v1' else 'v1.' || existing end;
  meta := jsonb_strip_nulls(jsonb_build_object(
    'label', new.metadata -> 'label', 'review_points', new.metadata -> 'review_points', 'inputs', new.metadata -> 'inputs',
    'proxy_path', new.metadata -> 'proxy_path'));
  what := left(coalesce(new.metadata ->> 'changes', ''), 2000);
  insert into public.gtm_story_asset_versions
    (asset_id, revision, label, sha256, kind, title, source, storage_path, poster_path, body, stage, changes, metadata)
  values
    (new.id, new.revision, next_label, new.sha256, new.kind, new.title, new.source, new.storage_path,
     new.metadata ->> 'poster_path', new.body, new.stage, what, meta)
  on conflict (asset_id, revision) do update
    set sha256 = excluded.sha256, title = excluded.title, source = excluded.source,
        storage_path = excluded.storage_path, poster_path = excluded.poster_path, body = excluded.body,
        stage = excluded.stage, changes = excluded.changes, metadata = excluded.metadata;
  return null;
end $$;
revoke all on function public.gtm_story_asset_versioned() from public, anon, authenticated;
