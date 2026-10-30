-- Behaviour tests for 20261013160000_content_review_large_video.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_content_review_large_video.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select is((select file_size_limit from storage.buckets where id = 'content-review'), 5368709120::bigint,
  'content-review takes files up to 5 GiB (a full episode final)');
select ok((select not public from storage.buckets where id = 'content-review'), 'content-review stays private');

set local role service_role;
insert into public.gtm_stories (id, title, link_url) values ('big-story', 'Big Story', 'https://example.com/big');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, metadata) values
  ('big-video', 'big-story', 'Episode', 'video', 'episode.mp4', repeat('a', 64), 'stories/big-story/big-video-aaaaaaaaaaaaaaaa.mp4',
   '{"proxy_path":"stories/big-story/big-video-aaaaaaaaaaaaaaaa-proxy.mp4","label":"v1"}');
select is((select metadata ->> 'proxy_path' from public.gtm_story_asset_versions where asset_id = 'big-video'),
  'stories/big-story/big-video-aaaaaaaaaaaaaaaa-proxy.mp4', 'a version keeps its review proxy');
select is((select metadata ->> 'label' from public.gtm_story_asset_versions where asset_id = 'big-video'), 'v1',
  'the rest of the version metadata is unchanged');

select * from finish();
rollback;
