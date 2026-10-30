-- Behaviour tests for 20261012120000_gtm_engage_learning.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_engage_learning.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_comments (id, source, platform, external_id, text)
  values ('00000000-0000-0000-0000-0000000000f1', 'poll', 'linkedin', 'learn-1', 'Love this perspective.');
select lives_ok($$update public.gtm_comments set author_headline = 'Operations at Example Network', author_company = 'Example Network',
  author_website = 'https://example.test', author_profile_url = 'https://example.test', author_followers = 0,
  author_enriched_at = now(), reclassified_from = 'spam', lesson_set = 'abc123' where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'a comment records the commenter profile, John''s correction and the lesson set');
select throws_ok($$update public.gtm_comments set author_website = 'javascript:alert(1)' where id = '00000000-0000-0000-0000-0000000000f1'$$, '23514', null, 'a website is an http(s) link');
select throws_ok($$update public.gtm_comments set author_profile_url = 'linkedin.com/in/x' where id = '00000000-0000-0000-0000-0000000000f1'$$, '23514', null, 'a profile link is an http(s) link');
select throws_ok($$update public.gtm_comments set reclassified_from = 'maybe' where id = '00000000-0000-0000-0000-0000000000f1'$$, '23514', null, 'only known classifications');
select throws_ok($$update public.gtm_comments set author_headline = repeat('x', 401) where id = '00000000-0000-0000-0000-0000000000f1'$$, '23514', null, 'the headline is short');
select lives_ok($$insert into public.gtm_comment_runs (kind) values ('learn')$$, 'a learning run is recorded');
select throws_ok($$insert into public.gtm_comment_runs (kind) values ('dream')$$, '23514', null, 'only known run kinds');
select lives_ok($$insert into public.gtm_engage_lessons (id, kind, lesson, evidence) values
  ('00000000-0000-0000-0000-0000000000f2', 'voice', 'Opens with the person''s name and a warm, specific reaction.', '{00000000-0000-0000-0000-0000000000f1}')$$, 'a lesson is recorded');
select throws_ok($$insert into public.gtm_engage_lessons (kind, lesson) values ('vibes', 'x y z')$$, '23514', null, 'only known lesson kinds');
select throws_ok($$insert into public.gtm_engage_lessons (kind, lesson) values ('voice', '  ')$$, '23514', null, 'a lesson has words');
select throws_ok($$update public.gtm_engage_lessons set status = 'retired' where id = '00000000-0000-0000-0000-0000000000f2'$$, '23514', null, 'a retired lesson says when');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_engage_lessons$$, '42501', null, 'anonymous cannot read lessons');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_engage_lessons), 0::bigint, 'a signed-in non-owner reads no lessons');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) >= 1 from public.gtm_engage_lessons), 'owner reads lessons');
select throws_ok($$update public.gtm_engage_lessons set status = 'retired', retired_at = now()$$, '42501', null, 'even the owner retires a lesson only through the server');

select * from finish();
rollback;
