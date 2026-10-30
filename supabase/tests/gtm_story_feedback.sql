-- Behaviour tests for 20261005120000_gtm_story_feedback.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_feedback.sql   (also `supabase test db`)
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
insert into public.gtm_stories (id, title, link_url) values ('fb-story', 'Feedback Story', 'https://example.com/story');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values
  ('fb-copy', 'fb-story', 'Copy', 'copy', 'copy.md', repeat('a', 64), 'Text');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_story_feedback$$, '42501', null, 'anonymous cannot read feedback');

select pg_temp.as_role('authenticated', false);
select throws_ok($$select public.gtm_add_story_feedback('fb-copy', 'linkedin', 'x')$$,
  '42501', null, 'non-owner cannot add feedback');
select throws_ok($$insert into public.gtm_story_feedback (asset_id, body) values ('fb-copy', 'x')$$,
  '42501', null, 'nobody inserts feedback directly');

select pg_temp.as_role('authenticated', true);
select lives_ok($$select public.gtm_add_story_feedback('fb-copy', 'linkedin', 'Tighten the opening')$$,
  'owner adds feedback');
select ok((select count(*) from public.gtm_story_feedback) = 1, 'owner reads feedback');
select throws_ok($$select public.gtm_add_story_feedback('fb-copy', 'linkedin', '   ')$$,
  '22023', null, 'blank feedback is refused');
select throws_ok($$update public.gtm_story_feedback set resolved_at = now()$$,
  '42501', null, 'owner cannot resolve feedback');

select pg_temp.as_role('service_role', null);
select lives_ok($$update public.gtm_story_feedback set resolved_at = now(), resolution = 'Fixed in v2'$$, 'service role resolves feedback');
select throws_ok($$update public.gtm_story_feedback set resolution = 'orphan reply', resolved_at = null$$,
  '23514', null, 'a reply needs a resolved note');

select * from finish();
rollback;
