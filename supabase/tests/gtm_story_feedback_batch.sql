-- Behaviour tests for 20261012240000_gtm_story_feedback_batch.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_feedback_batch.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url, series) values
  ('batch-a', 'A', 'https://example.com/a', 'batch-series'), ('batch-b', 'B', 'https://example.com/b', 'batch-series');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage) values
  ('batch-a-video', 'batch-a', 'Video', 'video', 'a.mp4', repeat('a', 64), 'stories/a.mp4', 'rough-cut'),
  ('batch-b-video', 'batch-b', 'Video', 'video', 'b.mp4', repeat('b', 64), 'stories/b.mp4', 'rough-cut');

select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_add_story_feedback('batch-a-video', null, 'End card sub-line is too small', '00000000-0000-4000-8000-0000000000aa')$$, 'a series note on the first piece');
select lives_ok($$select public.gtm_add_story_feedback('batch-b-video', null, 'End card sub-line is too small', '00000000-0000-4000-8000-0000000000aa')$$, 'the same note on the second piece');
select lives_ok($$select public.gtm_add_story_feedback('batch-b-video', null, 'A note of its own')$$, 'three-argument calls still work');
select results_eq($$select asset_id, stage, batch_id from public.gtm_story_feedback where asset_id like 'batch-%' order by created_at, asset_id, body$$,
  $$values ('batch-a-video'::text, 'rough-cut'::text, '00000000-0000-4000-8000-0000000000aa'::uuid), ('batch-b-video', 'rough-cut', null), ('batch-b-video', 'rough-cut', '00000000-0000-4000-8000-0000000000aa'::uuid)$$,
  'the batch id and the stage are recorded on each row');

select pg_temp.as_role('authenticated', false);
select throws_ok($$select public.gtm_add_story_feedback('batch-a-video', null, 'x', null)$$, '42501', null, 'a non-owner cannot leave a note');

select * from finish();
rollback;
