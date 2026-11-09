-- Behaviour tests for 20261109030000_gtm_team_calendars.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_team_calendars.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
select lives_ok($$insert into public.gtm_team_calendars (member, address, token_ciphertext, granted_scopes)
  values ('JOHN', 'john@example.com', repeat('x', 60), '{https://www.googleapis.com/auth/calendar.readonly}')$$,
  'the service role stores a sealed calendar token');
select throws_ok($$insert into public.gtm_team_calendars (member, address, token_ciphertext) values ('JOHN', 'John@Example.com', repeat('x', 60))$$,
  '23514', null, 'a calendar address is stored lowercase');
select lives_ok($$insert into public.gtm_calendar_meetings (member, event_key, meeting_id, origin, start_at, kind)
  values ('JOHN', repeat('a', 32), '00000000-0000-4000-8000-000000000001', 'created', now(), 'CLIENT')$$,
  'the service role maps an event to a meeting row');
select throws_ok($$insert into public.gtm_calendar_meetings (member, event_key, meeting_id, origin, start_at, kind)
  values ('JOHN', 'abc123', '00000000-0000-4000-8000-000000000002', 'created', now(), 'CLIENT')$$,
  '23514', null, 'an event is stored only as a 32-character keyed hash, never its raw id');
select throws_ok($$insert into public.gtm_calendar_meetings (member, event_key, meeting_id, origin, start_at, kind)
  values ('JOHN', repeat('b', 32), '00000000-0000-4000-8000-000000000003', 'created', now(), 'INTERNAL')$$,
  '23514', null, 'an internal meeting is never written');
select throws_ok($$insert into public.gtm_calendar_meetings (member, event_key, meeting_id, origin, start_at, kind)
  values ('JOHN', repeat('a', 32), '00000000-0000-4000-8000-000000000004', 'adopted', now(), 'OTHER')$$,
  '23505', null, 'an event maps to one meeting row per member');

select lives_ok($$insert into public.gtm_calendar_meetings (member, event_key, origin, start_at, removed_at, removed_reason)
  values ('JOHN', repeat('c', 32), 'withheld', now(), now(), 'private')$$, 'a private event is withheld with no meeting row');
select throws_ok($$insert into public.gtm_calendar_meetings (member, event_key, origin, start_at, removed_at, removed_reason)
  values ('JOHN', repeat('d', 32), 'withheld', now(), now(), 'cancelled')$$, '23514', null, 'only a privacy reason withholds');
select throws_ok($$insert into public.gtm_calendar_meetings (member, event_key, origin, start_at, kind)
  values ('JOHN', repeat('e', 32), 'created', now(), 'OTHER')$$, '23514', null, 'a created or adopted row names its meeting');

select pg_temp.as_role('anon', null);
select throws_ok($$select member from public.gtm_team_calendars$$, '42501', null, 'anonymous cannot read calendar connections');
select throws_ok($$select member from public.gtm_calendar_meetings$$, '42501', null, 'anonymous cannot read the meeting map');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_team_calendars), 0::bigint, 'a signed-in non-owner sees no calendar connection');
select is((select count(*) from public.gtm_calendar_meetings), 0::bigint, 'a signed-in non-owner reads no meeting map');

select pg_temp.as_role('authenticated', true);
select is((select count(*) from public.gtm_team_calendars), 1::bigint, 'the owner sees the calendar connection status');
select throws_ok($$select token_ciphertext from public.gtm_team_calendars$$, '42501', null, 'not even the owner can read the sealed token');
select is((select count(*) from public.gtm_calendar_meetings), 2::bigint, 'the owner reads the meeting map');

select * from finish();
rollback;
