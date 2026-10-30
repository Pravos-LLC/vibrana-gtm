-- Behaviour tests for 20261016220000_gtm_people.sql (people John tags in posts).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_people.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_people (name, linkedin_url, linkedin_name, linkedin_urn, instagram_handle)
  values ('Test Person', 'https://www.linkedin.com/in/test-person', 'Test Person ⚡', 'urn:li:person:Ab_1-x', 'test.person');
select throws_ok($$insert into public.gtm_people (name) values ('test person')$$, '23505', null, 'a name is unique, whatever its case');
select throws_ok($$insert into public.gtm_people (name, linkedin_url) values ('Other', 'https://evil.example/in/x')$$, '23514', null, 'only LinkedIn profile or company URLs');
select throws_ok($$insert into public.gtm_people (name, linkedin_urn) values ('Other', 'urn:li:person:x) y')$$, '23514', null, 'a URN cannot break out of the mention syntax');
select throws_ok($$insert into public.gtm_people (name, instagram_handle) values ('Other', '@Bad Handle')$$, '23514', null, 'Instagram handles are bare and lowercase');

select pg_temp.as_role('authenticated', true);
select is((select count(*)::int from public.gtm_people where name = 'Test Person'), 1, 'the owner reads people');
select throws_ok($$insert into public.gtm_people (name) values ('Sneaky')$$, '42501', null, 'the owner cannot write directly');

select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_people), 0, 'a non-owner reads nothing');

select pg_temp.as_role('anon', null);
select throws_ok($$select count(*) from public.gtm_people$$, '42501', null, 'anon has no access');

select * from finish();
rollback;
