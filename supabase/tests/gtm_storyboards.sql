-- Behaviour tests for 20261013100000_gtm_storyboards.sql (Storyboard Studio).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_storyboards.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

-- Two shorts in one series, each with a B-roll + Motion plan at v1; the first has two scenes.
select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url, pipeline, series) values
  ('sb-a', 'Story A', 'https://example.com/a', 'short', 'sb-series'),
  ('sb-b', 'Story B', 'https://example.com/b', 'short', 'sb-series');
insert into public.gtm_story_stages (story_id, stage, status) values ('sb-a', 'enhance-plan', 'review'), ('sb-b', 'enhance-plan', 'review');
insert into public.gtm_storyboards (id, story_id, stage, format, series, title, current_version, status) values
  ('sb-a-enhance-plan', 'sb-a', 'enhance-plan', 'short', 'sb-series', 'A plan', 1, 'review'),
  ('sb-b-enhance-plan', 'sb-b', 'enhance-plan', 'short', 'sb-series', 'B plan', 1, 'review');
insert into public.gtm_storyboard_versions (storyboard_id, version, doc, doc_sha, schema, scene_shas, produced_by, motion_sha, motion_path, credit_cap) values
  ('sb-a-enhance-plan', 1, '{"schema":"vibrana.storyboard/1"}', repeat('d', 64), 'vibrana.storyboard/1',
   jsonb_build_object('sc-hook', repeat('1', 64), 'sc-br1', repeat('2', 64)), 'vibrana-podcast-clips', repeat('f', 64) , 'motion.so', 200),
  ('sb-b-enhance-plan', 1, '{"schema":"vibrana.storyboard/1"}', repeat('e', 64), 'vibrana.storyboard/1',
   jsonb_build_object('sc-hook', repeat('3', 64)), 'vibrana-podcast-clips', null, 'code-studio', null);

-- Seeded standing rules.
select results_eq($$select count(*)::int from public.gtm_storyboard_rules where source = 'john' and status = 'active' and format = 'short'$$,
  $$values (3)$$, 'John''s three standing rules are seeded');
select ok((select conflict_resolution <> '' from public.gtm_storyboard_rules where rule like 'Text and Motion graphics sit in the top third%'),
  'the top-third rule records John''s ruling on the 64% conflict');

-- RLS: the owner reads, nobody else does, and the browser never writes directly.
select pg_temp.as_role('authenticated', false);
select results_eq($$select count(*)::int from public.gtm_storyboards$$, $$values (0)$$, 'a non-owner reads no storyboards');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{}', 'note', 'hi')$$, '42501', null, 'a non-owner cannot comment');
select pg_temp.as_role('authenticated', true);
select results_eq($$select count(*)::int from public.gtm_storyboards$$, $$values (2)$$, 'the owner reads storyboards');
select throws_ok($$insert into public.gtm_storyboard_comments (storyboard_id, version, kind, body) values ('sb-a-enhance-plan', 1, 'note', 'x')$$,
  '42501', null, 'the owner cannot insert a comment directly');
select throws_ok($$update public.gtm_storyboards set status = 'approved'$$, '42501', null, 'the owner cannot approve by writing the row');

-- Comments: anchors validated, the scene must exist in that version.
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{"region":[0.1,0.2,1.4,0.1]}', 'note', 'x')$$,
  '22023', null, 'a region outside 0..1 is refused');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{"color":"red"}', 'note', 'x')$$,
  '22023', null, 'an unknown anchor key is refused');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{"t_start":4,"t_end":2}', 'note', 'x')$$,
  '22023', null, 'a time range that ends before it starts is refused');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{"scene_id":"sc-nope"}', 'note', 'x')$$,
  '22023', null, 'a scene that is not in the version is refused');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 2, '{}', 'note', 'x')$$,
  'P0001', 'storyboard version not found', 'a version that does not exist is refused');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{}', 'shout', 'x')$$,
  '22023', null, 'an unknown kind is refused');
select throws_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{}', 'swap', 'x', '{"element":"br1"}')$$,
  '22023', null, 'a proposal names its op');
select lives_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1,
  '{"scene_id":"sc-br1","element_id":"br1","lane":"broll","region":[0.1,0.3,0.8,0.5],"t":46}', 'reselect',
  'this shot shows corn not the thatch house', '{"op":"reselect","element":"br1","src_in":31.4,"src_out":33.2}')$$,
  'a region note with a reselect proposal is accepted');
select results_eq($$select kind, status, author, scope from public.gtm_storyboard_comments where storyboard_id = 'sb-a-enhance-plan'$$,
  $$values ('reselect'::text, 'open'::text, 'john'::text, 'this'::text)$$, 'the note is open, by John, for this clip');

-- Storyboard approval is refused while a note is open, scenes are unapproved, or the page is stale.
select throws_ok($$select public.gtm_decide_storyboard('sb-a-enhance-plan', 1, repeat('d', 64), 'approved', '', true)$$,
  '22023', null, 'an open note blocks the approval');
select pg_temp.as_role('service_role', null);
update public.gtm_storyboard_comments set status = 'addressed', addressed_in = 1, resolution = 're-cut to 31.4-33.2'
 where storyboard_id = 'sb-a-enhance-plan';
select pg_temp.as_role('authenticated', true);

-- Scene decisions bind to the sha.
select throws_ok($$select public.gtm_decide_storyboard_scene('sb-a-enhance-plan', 1, 'sc-br1', repeat('9', 64), 'approved')$$,
  'PT409', null, 'a stale scene sha is refused');
select throws_ok($$select public.gtm_decide_storyboard_scene('sb-a-enhance-plan', 1, 'sc-br1', repeat('2', 64), 'changes', ' ')$$,
  '22023', null, 'changes need a note');
select lives_ok($$select public.gtm_decide_storyboard_scene('sb-a-enhance-plan', 1, 'sc-br1', repeat('2', 64), 'approved')$$,
  'the owner approves a scene');
select results_eq($$select status from public.gtm_storyboard_comments where storyboard_id = 'sb-a-enhance-plan'$$,
  $$values ('resolved'::text)$$, 'approving the scene resolves the note the agent addressed');
select results_eq($$select public.gtm_storyboard_unapproved_scenes('sb-a-enhance-plan', 1)$$, $$values ('sc-hook'::text)$$,
  'one scene is still unapproved');
select throws_ok($$select public.gtm_decide_storyboard('sb-a-enhance-plan', 1, repeat('d', 64), 'approved', '')$$,
  '22023', 'scenes not approved yet: sc-hook', 'an unapproved scene blocks the approval');
select throws_ok($$select public.gtm_decide_storyboard('sb-a-enhance-plan', 1, repeat('0', 64), 'approved', '', true)$$,
  'PT409', null, 'a stale doc sha is refused');
select throws_ok($$select public.gtm_decide_storyboard('sb-a-enhance-plan', 2, repeat('d', 64), 'approved', '', true)$$,
  'PT409', null, 'a version that is not current is refused');

-- Approve (with the remaining scene): stage approved, decision logged, Motion.so spend authorized at the cap.
select lives_ok($$select public.gtm_decide_storyboard('sb-a-enhance-plan', 1, repeat('d', 64), 'approved', '', true)$$,
  'the owner approves the storyboard and its remaining scene');
select results_eq($$select status from public.gtm_storyboards where id = 'sb-a-enhance-plan'$$, $$values ('approved'::text)$$, 'the storyboard is approved');
select results_eq($$select status, actor from public.gtm_story_stages where story_id = 'sb-a' and stage = 'enhance-plan'$$,
  $$values ('approved'::text, 'john'::text)$$, 'the pipeline stage is approved by John');
select results_eq($$select decision, assets -> 0 ->> 'storyboard_id', (assets -> 0 ->> 'version')::int, assets -> 0 ->> 'doc_sha' = repeat('d', 64)
    from public.gtm_story_stage_decisions where story_id = 'sb-a'$$,
  $$values ('approved'::text, 'sb-a-enhance-plan'::text, 1, true)$$, 'the decision is logged against the storyboard version and doc');
select results_eq($$select kind, credits, motion_sha = repeat('f', 64) from public.gtm_storyboard_spend where storyboard_id = 'sb-a-enhance-plan'$$,
  $$values ('authorized'::text, 200::numeric, true)$$, 'one Motion.so create is authorized up to the cap, bound to the Motion lanes');
select results_eq($$select count(*)::int from public.gtm_story_asset_channels c join public.gtm_story_assets a on a.id = c.asset_id where a.story_id = 'sb-a' and c.status = 'approved'$$,
  $$values (0)$$, 'nothing is approved for a platform, so nothing can schedule');
select throws_ok($$select public.gtm_decide_storyboard_scene('sb-a-enhance-plan', 1, 'sc-hook', repeat('1', 64), 'cleared')$$,
  '22023', null, 'an approved storyboard is reopened before a scene changes');

-- Append-only.
select pg_temp.as_role('service_role', null);
select throws_ok($$update public.gtm_storyboard_versions set changes = 'x'$$, '42501', null, 'versions are append-only');
select throws_ok($$delete from public.gtm_storyboard_scene_decisions$$, '42501', null, 'scene decisions are append-only');

-- Reopen: the stage reads changes and the later stages go back to todo.
insert into public.gtm_story_stages (story_id, stage, status) values ('sb-a', 'broll', 'done');
select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_reopen_storyboard('sb-a-enhance-plan', 'Re-crop the GPU rack', array['broll', 'motion'])$$, 'the owner reopens');
select results_eq($$select stage, status from public.gtm_story_stages where story_id = 'sb-a' order by stage$$,
  $$values ('broll'::text, 'todo'::text), ('enhance-plan', 'changes')$$, 'the plan reads changes and B-roll is to do again');

-- A code-studio render spends no credits, so its approval authorizes nothing.
select lives_ok($$select public.gtm_decide_storyboard('sb-b-enhance-plan', 1, repeat('e', 64), 'approved', '', true)$$, 'the code-studio plan is approved');
select results_eq($$select count(*)::int from public.gtm_storyboard_spend where storyboard_id = 'sb-b-enhance-plan'$$, $$values (0)$$,
  'no Motion.so credits are authorized for the code studio');

-- Series scope: the note lands on every sibling at the stage with one batch id, and becomes a standing rule.
select pg_temp.as_role('service_role', null);
update public.gtm_storyboards set status = 'review' where id = 'sb-b-enhance-plan';
select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_add_storyboard_comment('sb-a-enhance-plan', 1, '{"scene_id":"sc-hook"}', 'note',
  'put graphics in the top third', null, 'series', 'Graphics sit in the top third', 'layout')$$, 'a series note is accepted');
select results_eq($$select count(distinct storyboard_id)::int, count(distinct batch_id)::int from public.gtm_storyboard_comments where scope = 'series'$$,
  $$values (2, 1)$$, 'the note is on both clips with one batch id');
select results_eq($$select r.rule, r.series, cardinality(r.evidence) from public.gtm_storyboard_rules r where r.rule = 'Graphics sit in the top third'$$,
  $$values ('Graphics sit in the top third'::text, 'sb-series'::text, 2)$$, 'it is a standing rule for the series with both notes as evidence');

select * from finish();
rollback;
