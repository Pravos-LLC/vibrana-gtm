-- Behaviour tests for 20260928160000_gtm_story_assets.sql (as amended by 20261013180000_gtm_story_approval_follows_bytes.sql).
-- Run against a non-production database with the migration applied:
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story.sql
-- Also runs under `supabase test db` (CI `database` job). Every expectation is a TAP assertion
-- (ok / throws_ok with the expected SQLSTATE / lives_ok), counted by plan().
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url) values ('story-test', 'Test Story', 'https://example.com/story');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values
  ('story-copy', 'story-test', 'Copy', 'copy', 'copy.md', repeat('a', 64), 'First version');
insert into public.gtm_story_asset_channels (asset_id, channel) values
  ('story-copy', 'youtube'), ('story-copy', 'linkedin');

-- The decision RPC is SECURITY DEFINER: only signed-in users may execute it
-- (its own owner check is the second layer, exercised below).
select ok(not has_function_privilege('anon',
  'public.gtm_decide_story_asset(text,text,text,text,text,bigint)', 'execute'),
  'anon has no execute grant on the decision RPC');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_stories$$,
  '42501', null, 'anonymous cannot read Stories');
select throws_ok($$select public.gtm_decide_story_asset('story-copy','youtube','approved','',repeat('a',64),1)$$,
  '42501', null, 'anonymous cannot call decision RPC');

select pg_temp.as_role('authenticated', false);
select ok((select count(*) from public.gtm_stories) = 0, 'non-owner reads no Stories');
select ok((select count(*) from public.gtm_story_assets) = 0, 'non-owner reads no assets');
select throws_ok($$select public.gtm_decide_story_asset('story-copy','youtube','approved','',repeat('a',64),1)$$,
  '42501', null, 'non-owner cannot approve');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) from public.gtm_story_asset_channels) = 2, 'owner reads channel decisions');
select throws_ok($$update public.gtm_story_asset_channels set status='approved' where asset_id='story-copy'$$,
  '42501', null, 'owner cannot bypass compare-and-lock RPC');
select lives_ok($lives$select public.gtm_decide_story_asset('story-copy','youtube','approved','',repeat('a',64),1)$lives$, 'owner approves the current version');
select ok((select status = 'approved' and approved_sha256 = repeat('a',64) and reviewed_by is not null
  from public.gtm_story_asset_channels where asset_id='story-copy' and channel='youtube'), 'owner approval stores current digest and reviewer');
select ok((select status = 'pending' from public.gtm_story_asset_channels
  where asset_id='story-copy' and channel='linkedin'), 'other channel stays pending');

select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set sha256 = repeat('b', 64), body = 'Second version' where id='story-copy';
select pg_temp.as_role('authenticated', true);
select ok((select status = 'pending' and approved_sha256 is null from public.gtm_story_asset_channels
  where asset_id='story-copy' and channel='youtube'), 'staging a new version clears approval');
select throws_ok($$select public.gtm_decide_story_asset('story-copy','youtube','approved','',repeat('a',64),1)$$,
  'PT409', 'Story asset changed; refresh and review the new version', 'stale page cannot approve the new version');
select lives_ok($lives$select public.gtm_decide_story_asset('story-copy','youtube','approved','',repeat('b',64),2)$lives$, 'owner approves the fresh version');
select ok((select approved_sha256 = repeat('b',64) from public.gtm_story_asset_channels
  where asset_id='story-copy' and channel='youtube'), 'fresh page approves the new version');

select pg_temp.as_role('service_role', null);
update public.gtm_story_assets set title = 'Revised Copy' where id='story-copy';
select pg_temp.as_role('authenticated', true);
-- Since 20261013180000 an approval follows the bytes: a title-only revision keeps it (the revision still bumps).
select ok((select status = 'approved' and approved_sha256 = repeat('b',64) from public.gtm_story_asset_channels
  where asset_id='story-copy' and channel='youtube'), 'a title-only revision keeps the approval of identical bytes');
select throws_ok($$select public.gtm_decide_story_asset('story-copy','youtube','approved','',repeat('b',64),2)$$,
  'PT409', 'Story asset changed; refresh and review the new version', 'stale page cannot approve a title-only revision');
select throws_ok($$select public.gtm_decide_story_asset('story-copy','linkedin','rejected','',repeat('b',64),3)$$,
  '22023', null, 'rejection requires a note');
select lives_ok($lives$select public.gtm_decide_story_asset('story-copy','linkedin','rejected','Needs correction',repeat('b',64),3)$lives$, 'owner rejects with a note');
select ok((select status = 'rejected' and note = 'Needs correction'
  from public.gtm_story_asset_channels where asset_id='story-copy' and channel='linkedin'), 'channel rejection records the note');

reset role;
select * from finish();
rollback;
