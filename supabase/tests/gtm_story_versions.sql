-- Behaviour tests for 20261005140000_gtm_story_versions.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_versions.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url) values ('ver-story', 'Version Story', 'https://example.com/story');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values
  ('ver-copy', 'ver-story', 'Copy', 'copy', 'copy.md', repeat('a', 64), 'First version');
select ok((select count(*) = 1 and min(label) = 'v1' from public.gtm_story_asset_versions where asset_id = 'ver-copy'),
  'a new asset starts at v1');
update public.gtm_story_assets set body = 'Second', sha256 = repeat('b', 64) where id = 'ver-copy';
select ok((select array_agg(label order by revision) = array['v1', 'v1.1'] from public.gtm_story_asset_versions where asset_id = 'ver-copy'),
  'an edit adds v1.1');
select ok((select body = 'First version' from public.gtm_story_asset_versions where asset_id = 'ver-copy' and label = 'v1'),
  'the earlier version keeps its body');
update public.gtm_story_assets set metadata = '{"poster_path":"stories/x-poster.jpg"}' where id = 'ver-copy';
select ok((select count(*) = 2 and bool_or(poster_path = 'stories/x-poster.jpg') from public.gtm_story_asset_versions where asset_id = 'ver-copy'),
  'metadata-only changes refresh the current version, not add one');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_story_asset_versions$$, '42501', null, 'anonymous cannot read versions');

select pg_temp.as_role('authenticated', false);
select ok((select count(*) from public.gtm_story_asset_versions) = 0, 'non-owner reads no versions');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) from public.gtm_story_asset_versions where asset_id = 'ver-copy') = 2, 'owner reads versions');
select throws_ok($$delete from public.gtm_story_asset_versions$$, '42501', null, 'owner cannot delete versions');
select throws_ok($$update public.gtm_story_asset_versions set label = 'v9'$$, '42501', null, 'owner cannot edit versions');
select lives_ok($$select public.gtm_add_story_feedback('ver-copy', 'linkedin', 'About version two')$$, 'owner adds feedback');
select ok((select revision = 2 from public.gtm_story_feedback where body = 'About version two'),
  'feedback records the revision it was written against');

select * from finish();
rollback;
