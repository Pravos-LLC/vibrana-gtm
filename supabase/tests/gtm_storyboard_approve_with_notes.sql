-- Behaviour tests for 20261013140000_gtm_storyboard_approve_with_notes.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url, pipeline) values ('awn', 'Story', 'https://example.com/awn', 'short');
insert into public.gtm_storyboards (id, story_id, stage, format, title, current_version, status) values ('sb-awn', 'awn', 'enhance-plan', 'short', 'Plan', 1, 'review');
insert into public.gtm_storyboard_versions (storyboard_id, version, doc, doc_sha, schema, scene_shas, produced_by, motion_path)
  values ('sb-awn', 1, '{}', repeat('d', 64), 'vibrana.storyboard/1', jsonb_build_object('sc-a', repeat('1', 64), 'sc-b', repeat('2', 64)), 'test', 'code-studio');

select pg_temp.as_role('authenticated', true);
-- A scene approved with a note: approved, and the note is an instruction for the render.
select lives_ok($$select public.gtm_decide_storyboard_scene('sb-awn', 1, 'sc-a', repeat('1', 64), 'approved', 'warmer color on the map')$$, 'approve a scene with a note');
select results_eq($$select body, status, apply_in_render from public.gtm_storyboard_comments where storyboard_id = 'sb-awn'$$,
  $$values ('warmer color on the map'::text, 'open'::text, true)$$, 'the note is open and marked apply in render');
select results_eq($$select public.gtm_storyboard_unapproved_scenes('sb-awn', 1)$$, $$values ('sc-b'::text)$$, 'the scene counts as approved');
-- An ordinary open note still blocks a plain approval.
select lives_ok($$select public.gtm_add_storyboard_comment('sb-awn', 1, '{"scene_id":"sc-b"}', 'note', 'trim the end a touch')$$, 'a plain note');
select throws_ok($$select public.gtm_decide_storyboard('sb-awn', 1, repeat('d', 64), 'approved', '', true)$$, '22023', null, 'an open plain note blocks a plain approval');
-- Approve with notes: allowed; every open note becomes an instruction, the overall note too.
select lives_ok($$select public.gtm_decide_storyboard('sb-awn', 1, repeat('d', 64), 'approved', 'all minor, go', true, true)$$, 'approve with notes');
select results_eq($$select status from public.gtm_storyboards where id = 'sb-awn'$$, $$values ('approved'::text)$$, 'the storyboard is approved');
select results_eq($$select count(*)::int from public.gtm_storyboard_comments where storyboard_id = 'sb-awn' and status = 'open' and apply_in_render$$,
  $$values (3)$$, 'the two notes and the overall note are open instructions for the render');
select results_eq($$select status from public.gtm_story_stages where story_id = 'awn' and stage = 'enhance-plan'$$, $$values ('approved'::text)$$, 'the stage moves');

select * from finish();
rollback;
