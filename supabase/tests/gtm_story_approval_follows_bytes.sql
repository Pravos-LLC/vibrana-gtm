-- Behaviour tests for 20261013180000_gtm_story_approval_follows_bytes.sql: a restage that moves an asset's storage key
-- (or its source path or title) keeps an approval of identical bytes; new bytes clear it; a stage move still clears it.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_approval_follows_bytes.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url) values ('bytes-story', 'Bytes Story', 'https://example.com/bytes');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage) values
  ('bytes-video', 'bytes-story', 'Video', 'video', 'cut.mp4', repeat('a', 64), 'stories/bytes-story/bytes-video-aaaaaaaaaaaaaaaa.mp4', 'final');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values
  ('bytes-copy', 'bytes-story', 'Caption', 'copy', 'caption.md', repeat('c', 64), 'The caption');
insert into public.gtm_story_asset_channels (asset_id, channel) values
  ('bytes-video', 'linkedin'), ('bytes-video', 'instagram'), ('bytes-copy', 'instagram');

select pg_temp.as_role('authenticated', true);
select public.gtm_decide_story_asset('bytes-video', 'linkedin', 'approved', '', repeat('a', 64), 1);
select public.gtm_decide_story_asset('bytes-video', 'instagram', 'approved', '', repeat('a', 64), 1);
select public.gtm_decide_story_asset('bytes-copy', 'instagram', 'approved', '', repeat('c', 64), 1);
select is((select count(*)::int from public.gtm_story_asset_channels where status = 'approved'), 3, 'John approved video and caption');

-- The restage that hit s1-14 and s1-16: identical bytes, the storage key moves.
select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set storage_path = 'stories/bytes-story/bytes-video-moved.mp4' where id = 'bytes-video';
select is((select revision from public.gtm_story_assets where id = 'bytes-video'), 2::bigint, 'a moved key is a new revision');
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'bytes-video' and status = 'approved' and approved_sha256 = repeat('a', 64)), 2,
  'identical bytes under a new storage key keep both platform approvals');
select ok((select reviewed_by = '00000000-0000-0000-0000-000000000001' from public.gtm_story_asset_channels where asset_id = 'bytes-video' and channel = 'linkedin'),
  'the carried approval is still John''s');

select pg_temp.as_role('authenticated', true);
select throws_ok($$select public.gtm_decide_story_asset('bytes-video','linkedin','rejected','x',repeat('a',64),1)$$,
  'PT409', 'Story asset changed; refresh and review the new version', 'a page opened on the old revision still cannot decide');

select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set source = 'renamed/cut.mp4', title = 'Video 9:16' where id = 'bytes-video';
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'bytes-video' and status = 'approved'), 2,
  'a new source path or title on identical bytes keeps the approvals');

update public.gtm_story_assets set source = 'caption-v2.md', title = 'Instagram caption' where id = 'bytes-copy';
select ok((select status = 'approved' and approved_sha256 = repeat('c', 64) from public.gtm_story_asset_channels where asset_id = 'bytes-copy'),
  'identical text keeps its approval');

update public.gtm_story_assets set sha256 = repeat('d', 64), body = 'The caption, edited' where id = 'bytes-copy';
select ok((select status = 'pending' and approved_sha256 is null from public.gtm_story_asset_channels where asset_id = 'bytes-copy'),
  'changed text resets its approval');

update public.gtm_story_assets set sha256 = repeat('b', 64), storage_path = 'stories/bytes-story/bytes-video-bbbbbbbbbbbbbbbb.mp4' where id = 'bytes-video';
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'bytes-video' and status = 'approved'), 0,
  'new bytes reset every approval, as before');

select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_decide_story_asset('bytes-video','linkedin','approved','',repeat('b',64),4)$$, 'John approves the new bytes');

-- A stage move clears approvals even when the key moves with identical bytes (a final approval is not a rough-cut one).
select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set stage = 'rough-cut', storage_path = 'stories/bytes-story/bytes-video-rough.mp4' where id = 'bytes-video';
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'bytes-video' and status = 'approved'), 0,
  'moving stage with a moved key still clears the approval');

-- An approval already stale (approved_sha256 is other bytes) is cleared, never carried, when the key moves.
update public.gtm_story_assets set stage = 'final' where id = 'bytes-video';
select pg_temp.as_role('authenticated', true);
select public.gtm_decide_story_asset('bytes-video','instagram','approved','',repeat('b',64),5);
reset role;
alter table public.gtm_story_asset_channels disable trigger gtm_story_approval_guard;
update public.gtm_story_asset_channels set approved_sha256 = repeat('e', 64) where asset_id = 'bytes-video' and channel = 'instagram';
alter table public.gtm_story_asset_channels enable trigger gtm_story_approval_guard;
select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set storage_path = 'stories/bytes-story/bytes-video-again.mp4' where id = 'bytes-video';
select ok((select status = 'pending' and approved_sha256 is null from public.gtm_story_asset_channels where asset_id = 'bytes-video' and channel = 'instagram'),
  'a stale approval for other bytes is not carried to the new key');
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'bytes-video' and status = 'approved'), 0, 'nothing approved remains for other bytes');

select * from finish();
rollback;
