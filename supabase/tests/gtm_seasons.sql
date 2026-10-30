-- Behaviour tests for 20261005160000_gtm_seasons.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_seasons.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_seasons (id, title, starts_on, ends_on) values ('test-season', 'Test', '2026-01-05', '2026-01-30');
select throws_ok($$insert into public.gtm_stories (id, title, link_url, season_id) values ('orphan', 't', 'https://example.com', 'no-such-season')$$,
  '23503', null, 'a Story can only belong to a real Season');
select lives_ok($$insert into public.gtm_stories (id, title, link_url, season_id) values ('in-season', 't', 'https://example.com', 'test-season')$$,
  'a Story joins a Season');
select throws_ok($$insert into public.gtm_seasons (id, title, starts_on, ends_on) values ('bad-dates', 'x', '2026-02-02', '2026-02-01')$$,
  '23514', null, 'a Season cannot end before it starts');
select throws_ok($$insert into public.gtm_seasons (id, title, starts_on, ends_on, pillars) values ('bad-pillar', 'x', '2026-02-01', '2026-02-02', '{nope}')$$,
  '23514', null, 'a Season only holds known pillars');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_seasons$$, '42501', null, 'anonymous cannot read Seasons');

select pg_temp.as_role('authenticated', false);
select throws_ok($$select public.gtm_update_season('test-season', 'T', '', '2026-01-05', '2026-01-30', '{proof}')$$,
  '42501', null, 'non-owner cannot edit a Season');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) >= 2 from public.gtm_seasons), 'owner reads Seasons');
select throws_ok($$update public.gtm_seasons set title = 'Direct'$$, '42501', null, 'nobody updates a Season directly');
select lives_ok($$select public.gtm_update_season('test-season', ' Winter run ', 'Description', '2026-01-05', '2026-02-27', '{proof,lists,proof}')$$,
  'owner edits a Season');
select ok((select title = 'Winter run' and ends_on = '2026-02-27' and pillars = array['lists', 'proof']
  from public.gtm_seasons where id = 'test-season'), 'the edit is stored, trimmed and de-duplicated');
select throws_ok($$select public.gtm_update_season('test-season', 'T', '', '2026-03-01', '2026-02-01', '{proof}')$$,
  '22023', null, 'reversed dates are refused');
select throws_ok($$select public.gtm_update_season('test-season', 'T', '', '2026-01-05', '2026-02-01', '{proof,video}')$$,
  '22023', null, 'unknown pillars are refused');
select throws_ok($$select public.gtm_update_season('missing', 'T', '', '2026-01-05', '2026-02-01', '{proof}')$$,
  'P0001', null, 'an unknown Season is refused');

select * from finish();
rollback;
