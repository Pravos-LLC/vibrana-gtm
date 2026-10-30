-- Behaviour tests for 20261012220000_gtm_story_stages.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_stages.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url, pipeline, series, third_party_who)
  values ('stage-story', 'Stage Story', 'https://example.com/story', 'short', 'stage-series', 'example_approver / Example Series');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage, metadata)
  values ('stage-video', 'stage-story', 'Video', 'video', 'v.mp4', repeat('a', 64), 'stories/stage-story/v.mp4', 'rough-cut',
          '{"label": "v4", "changes": "Raw-track audio", "review_points": [{"t": 9, "label": "B4"}], "bytes": 10}');

select results_eq($$select label, stage, changes, metadata from public.gtm_story_asset_versions where asset_id = 'stage-video'$$,
  $$values ('v1'::text, 'rough-cut'::text, 'Raw-track audio'::text, '{"label": "v4", "review_points": [{"t": 9, "label": "B4"}]}'::jsonb)$$,
  'a version records its stage, what changed, and the pipeline label and jump points');

update public.gtm_story_assets set sha256 = repeat('b', 64), stage = 'final', metadata = '{"changes": "B-roll and Motion"}' where id = 'stage-video';
select results_eq($$select label, stage, changes from public.gtm_story_asset_versions where asset_id = 'stage-video' order by revision$$,
  $$values ('v1'::text, 'rough-cut'::text, 'Raw-track audio'::text), ('v1.1', 'final', 'B-roll and Motion')$$,
  'a new version keeps the old one''s stage');

select throws_ok($$update public.gtm_stories set pipeline = 'podcast' where id = 'stage-story'$$, '23514', null, 'an unknown pipeline is refused');
select throws_ok($$update public.gtm_stories set third_party_who = '  ' where id = 'stage-story'$$, '23514', null, 'a blank third party is refused');

insert into public.gtm_story_stages (story_id, stage, status, note, actor) values ('stage-story', 'paper-edit', 'approved', 'John approved in terminal', 'agent');
select throws_ok($$insert into public.gtm_story_stages (story_id, stage, status) values ('stage-story', 'broll', 'finished')$$,
  '23514', null, 'an unknown status is refused');
insert into public.gtm_story_stage_decisions (story_id, stage, party, decision, note, assets)
  values ('stage-story', 'paper-edit', 'john', 'approved', 'John approved in terminal', '[]');
select throws_ok($$update public.gtm_story_stage_decisions set note = 'x'$$, '42501', null, 'decisions cannot be edited');
select throws_ok($$delete from public.gtm_story_stage_decisions$$, '42501', null, 'decisions cannot be deleted');

select pg_temp.as_role('authenticated', true);
select is((select count(*)::int from public.gtm_story_stages where story_id = 'stage-story'), 1, 'the owner reads stage progress');
select is((select count(*)::int from public.gtm_story_stage_decisions where story_id = 'stage-story'), 1, 'the owner reads the decision log');
select throws_ok($$insert into public.gtm_story_stages (story_id, stage, status) values ('stage-story', 'rough-cut', 'approved')$$,
  '42501', null, 'the browser role cannot record progress');
select throws_ok($$insert into public.gtm_story_stage_decisions (story_id, stage, party, decision) values ('stage-story', 'rough-cut', 'john', 'approved')$$,
  '42501', null, 'the browser role cannot write a decision');
select lives_ok($$select public.gtm_add_story_feedback('stage-video', null, 'The end card sub-line is too small')$$, 'the owner leaves a note');
select is((select stage from public.gtm_story_feedback where asset_id = 'stage-video'), 'final', 'a note records the stage it was written at');

select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_story_stages), 0, 'a non-owner reads nothing');

select pg_temp.as_role('service_role', null);
delete from public.gtm_stories where id = 'stage-story';

select * from finish();
rollback;
