-- Behaviour tests for 20261012210000_gtm_story_asset_stage.sql (as amended by 20261012230000_gtm_story_stage_decisions.sql).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_asset_stage.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url) values ('stage-story', 'Stage Story', 'https://example.com/story');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path) values
  ('stage-video', 'stage-story', 'Video', 'video', 'cut.mp4', repeat('a', 64), 'stories/stage-story/cut.mp4');
insert into public.gtm_story_asset_channels (asset_id, channel) values ('stage-video', 'youtube'), ('stage-video', 'instagram');

select is((select stage from public.gtm_story_assets where id = 'stage-video'), null, 'a new asset has no stage (final/legacy)');
select throws_ok($$update public.gtm_story_assets set stage = 'Rough Cut' where id = 'stage-video'$$,
  '23514', null, 'a stage is a lowercase key');

select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_decide_story_asset('stage-video','youtube','approved','',repeat('a',64),1)$$,
  'the owner approves the stageless asset');

select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set stage = 'rough-cut' where id = 'stage-video';
select ok((select status = 'approved' and approved_sha256 = repeat('a', 64) from public.gtm_story_asset_channels
  where asset_id = 'stage-video' and channel = 'youtube'), 'giving a stageless asset a stage keeps its approval');

-- Since 20261012230000 a rough cut is approved as a stage (gtm_decide_story_stage), never per platform.
select pg_temp.as_role('authenticated', true);
select throws_ok($$select public.gtm_decide_story_asset('stage-video','instagram','approved','',repeat('a',64),1)$$,
  '22023', null, 'a rough cut cannot be approved per platform');
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'stage-video' and status = 'approved'), 1,
  'only the approval given before the stage existed remains');

select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set stage = 'rough-cut', metadata = '{"bytes": 1}' where id = 'stage-video';
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'stage-video' and status = 'approved'), 1,
  'restaging at the same stage and bytes keeps the approvals');

update public.gtm_story_assets set stage = 'final' where id = 'stage-video';
select is((select count(*)::int from public.gtm_story_asset_channels where asset_id = 'stage-video' and status = 'approved'), 0,
  'moving to final clears rough-cut approvals, even on identical bytes');
select is((select revision from public.gtm_story_assets where id = 'stage-video'), 1::bigint,
  'a stage change alone does not bump the revision');

select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_decide_story_asset('stage-video','youtube','approved','',repeat('a',64),1)$$,
  'the owner approves the final');

select * from finish();
rollback;
