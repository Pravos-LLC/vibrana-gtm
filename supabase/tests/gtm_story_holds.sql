-- Behaviour tests for 20261012200000_gtm_story_holds.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_story_holds.sql   (also `supabase test db`)
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
insert into public.gtm_stories (id, title, link_url) values ('hold-story', 'Hold Story', 'https://example.com/story');

select pg_temp.as_role('authenticated', false);
select throws_ok($$select public.gtm_set_story_hold('hold-story', true, 'example_approver', 'x')$$,
  '42501', null, 'a non-owner cannot hold a Story');
select throws_ok($$update public.gtm_stories set held_at = now(), hold_who = 'x' where id = 'hold-story'$$,
  '42501', null, 'the browser role cannot write the hold columns directly');

select pg_temp.as_role('anon', null);
select throws_ok($$select public.gtm_set_story_hold('hold-story', true, 'example_approver', 'x')$$,
  '42501', null, 'anonymous cannot hold a Story');

select pg_temp.as_role('authenticated', true);
select is(public.gtm_set_story_hold('hold-story', true, '  example_approver / Example Series ', ' Waiting on the v4 cut '), true, 'the owner holds a Story');
select results_eq($$select hold_who, hold_note, held_at is not null, held_by from public.gtm_stories where id = 'hold-story'$$,
  $$values ('example_approver / Example Series'::text, 'Waiting on the v4 cut'::text, true, '00000000-0000-0000-0000-000000000001'::uuid)$$,
  'who and note are trimmed; the time and the owner are recorded by the database');
select lives_ok($$select public.gtm_set_story_hold('hold-story', true, '', '')$$, 'who and note are optional');
select throws_ok($$select public.gtm_set_story_hold('hold-story', true, repeat('x', 201), '')$$,
  '22023', null, 'who is short');
select throws_ok($$select public.gtm_set_story_hold('missing-story', true, 'x', '')$$,
  'P0001', 'Story not found', 'an unknown Story is refused');
select is(public.gtm_set_story_hold('hold-story', false, null, null), false, 'the owner releases the hold');
select results_eq($$select hold_who, hold_note, held_at, held_by from public.gtm_stories where id = 'hold-story'$$,
  $$values (null::text, ''::text, null::timestamptz, null::uuid)$$, 'release clears every hold column');

select pg_temp.as_role('service_role', null);
select throws_ok($$update public.gtm_stories set hold_who = 'x' where id = 'hold-story'$$,
  '23514', null, 'a who without a hold is refused');

select * from finish();
rollback;
