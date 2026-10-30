-- Behaviour tests for 20261013150000_gtm_storyboard_agent_notes_never_block.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url, pipeline) values ('anb', 'Story', 'https://example.com/anb', 'short');
insert into public.gtm_storyboards (id, story_id, stage, format, title, current_version, status) values ('sb-anb', 'anb', 'enhance-plan', 'short', 'Plan', 1, 'review');
insert into public.gtm_storyboard_versions (storyboard_id, version, doc, doc_sha, schema, scene_shas, produced_by, motion_path)
  values ('sb-anb', 1, '{}', repeat('d', 64), 'vibrana.storyboard/1', jsonb_build_object('sc-a', repeat('1', 64)), 'test', 'code-studio');
insert into public.gtm_storyboard_comments (storyboard_id, version, kind, body, author) values
  ('sb-anb', 1, 'note', '[agent pre-review] hook starts at 5%', 'agent'),
  ('sb-anb', 1, 'note', 'lint: band over the mouth', 'lint');

select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_decide_storyboard('sb-anb', 1, repeat('d', 64), 'approved', '', true)$$, 'open agent notes never block John''s approval');
select results_eq($$select status from public.gtm_storyboards where id = 'sb-anb'$$, $$values ('approved'::text)$$, 'approved');
select results_eq($$select count(*)::int from public.gtm_storyboard_comments where storyboard_id = 'sb-anb' and status = 'open' and not apply_in_render$$,
  $$values (2)$$, 'the agent notes stay, open and unchanged, for agents');
select pg_temp.as_role('service_role', null);
update public.gtm_storyboards set status = 'review' where id = 'sb-anb';
insert into public.gtm_storyboard_comments (storyboard_id, version, kind, body, author) values ('sb-anb', 1, 'note', 'John: trim the end', 'john');
select pg_temp.as_role('authenticated', true);
select throws_ok($$select public.gtm_decide_storyboard('sb-anb', 1, repeat('d', 64), 'approved', '', true)$$, '22023', null, 'an open note of John''s still needs an answer or approve with notes');

select * from finish();
rollback;
