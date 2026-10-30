-- Behaviour tests for 20261012230000_gtm_story_stage_decisions.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_stage_decisions.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url, pipeline, third_party_who)
  values ('dec-story', 'Decision Story', 'https://example.com/story', 'short', 'example_approver / Example Series');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage) values
  ('dec-video', 'dec-story', 'Video', 'video', 'v.mp4', repeat('a', 64), 'stories/dec-story/v.mp4', 'rough-cut'),
  ('dec-board', 'dec-story', 'Plan', 'image', 'b.png', repeat('b', 64), 'stories/dec-story/b.png', 'enhance-plan');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values
  ('dec-copy', 'dec-story', 'Caption', 'copy', 'c.md', repeat('c', 64), 'Caption');
insert into public.gtm_story_asset_channels (asset_id, channel) values ('dec-video', 'youtube'), ('dec-copy', 'youtube');
insert into public.gtm_story_stages (story_id, stage, status) values ('dec-story', 'paper-edit', 'approved'), ('dec-story', 'rough-cut', 'review');

select pg_temp.as_role('authenticated', false);
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'approved', '', '[{"asset_id":"dec-video","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  '42501', null, 'a non-owner cannot decide a stage');

select pg_temp.as_role('authenticated', true);
-- A platform approval is for the final only.
select throws_ok($$select public.gtm_decide_story_asset('dec-video', 'youtube', 'approved', '', repeat('a', 64), 1)$$,
  '22023', 'this is a rough cut (not the final); approve the stage, not the post', 'a rough cut cannot be approved per platform');
select lives_ok($$select public.gtm_decide_story_asset('dec-copy', 'youtube', 'approved', '', repeat('c', 64), 1)$$,
  'text has its own lane and is approved at any stage');
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'approved', '', '[{"asset_id":"dec-video","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","revision":1}]')$$,
  'PT409', null, 'stale bytes are refused');
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'approved', '', '[]')$$,
  '22023', null, 'a decision names what was looked at');
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'final', 'approved', '', '[{"asset_id":"dec-video","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  '22023', null, 'the final is approved per platform, never as a stage');
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'enhance-plan', 'approved', '', '[{"asset_id":"dec-video","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  'PT409', null, 'an asset from another stage is refused');
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'changes', ' ', '[{"asset_id":"dec-video","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  '22023', null, 'changes need a note');
select lives_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'changes', 'Lead with the robots line', '[{"asset_id":"dec-video","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  'the owner asks for changes to the rough cut');
select results_eq($$select status from public.gtm_story_stages where story_id = 'dec-story' and stage = 'rough-cut'$$, $$values ('changes'::text)$$, 'the stage reads changes');
select results_eq($$select body, stage, channel from public.gtm_story_feedback where asset_id = 'dec-video'$$,
  $$values ('Lead with the robots line'::text, 'rough-cut'::text, null::text)$$, 'the note is left on the asset, tagged with the stage');
select lives_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'approved', '', '[{"asset_id":"dec-video","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  'the owner approves the rough cut');
select results_eq($$select status, actor from public.gtm_story_stages where story_id = 'dec-story' and stage = 'rough-cut'$$, $$values ('approved'::text, 'john'::text)$$, 'the stage is approved by John');
select results_eq($$select count(*)::int from public.gtm_story_asset_channels where asset_id = 'dec-video' and status = 'approved'$$, $$values (0)$$,
  'a stage approval never touches a platform approval');
select results_eq($$select decision, party, assets ->> 0 is not null, decided_by from public.gtm_story_stage_decisions where story_id = 'dec-story' order by decision desc$$,
  $$values ('changes'::text, 'john'::text, true, '00000000-0000-0000-0000-000000000001'::uuid), ('approved', 'john', true, '00000000-0000-0000-0000-000000000001'::uuid)$$,
  'both decisions are logged against the bytes, by the owner');

-- Third party: refused while any platform media is short of final; once final, logged against the final's bytes.
select throws_ok($$select public.gtm_set_story_hold('dec-story', false, null, null)$$,
  '22023', null, 'the third party sees the final only: no release while the rough cut is the platform media');
select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set sha256 = repeat('e', 64), stage = 'final' where id = 'dec-video';
select pg_temp.as_role('authenticated', true);
select is(public.gtm_set_story_hold('dec-story', false, null, 'example_approver signed off by email'), false, 'released once the final is staged');
select results_eq($$select party, who, stage, assets from public.gtm_story_stage_decisions where story_id = 'dec-story' and party = 'third_party'$$,
  $$values ('third_party'::text, 'example_approver / Example Series'::text, 'final'::text, '[{"asset_id": "dec-video", "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "revision": 2}]'::jsonb)$$,
  'the sign-off is bound to the final''s bytes (the plan image is not a post)');
select lives_ok($$select public.gtm_decide_story_asset('dec-video', 'youtube', 'approved', '', repeat('e', 64), 2)$$, 'the final is approved per platform');

-- "Send back to rough cut" from the final: later stages return to todo and the final's platform approvals are withdrawn.
select lives_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'reopened', 'Cut the heck yeah', '[{"asset_id":"dec-video","sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","revision":2}]', array['enhance-plan'])$$,
  'the owner sends the final back to the rough cut');
select results_eq($$select (select status from public.gtm_story_stages where story_id = 'dec-story' and stage = 'rough-cut'), (select status from public.gtm_story_asset_channels where asset_id = 'dec-video' and channel = 'youtube')$$,
  $$values ('changes'::text, 'pending'::text)$$, 'the rough cut reads changes and the final can no longer schedule');

select pg_temp.as_role('anon', null);
select throws_ok($$select public.gtm_decide_story_stage('dec-story', 'rough-cut', 'approved', '', '[]')$$, '42501', null, 'anonymous cannot call it');

select * from finish();
rollback;
