-- Behaviour tests for 20261109010000_gtm_crm_people.sql (VIB-516).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_crm_people.sql   (also `supabase test db`)
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

-- Member A (workspace member ...a1) made three people by hand; the key "key-a" made one more for them; someone else made
-- two; one of A's was soft-deleted. A by-hand person dated before the window still counts in the totals.
insert into public.gtm_crm_people (id, created_at, updated_at, deleted_at, created_by_source, created_by_name, created_by_member, has_email, email_verification, not_sendable) values
  ('00000000-0000-0000-0000-000000000101', '2026-11-01T10:00:00Z', now(), null, 'MANUAL', 'A', '00000000-0000-0000-0000-0000000000a1', true,  'VERIFIED',   false),
  ('00000000-0000-0000-0000-000000000102', '2026-11-02T10:00:00Z', now(), null, 'MANUAL', 'A', '00000000-0000-0000-0000-0000000000a1', true,  'VERIFIED',   true),
  ('00000000-0000-0000-0000-000000000103', '2026-01-01T10:00:00Z', now(), null, 'MANUAL', 'A', '00000000-0000-0000-0000-0000000000a1', false, 'UNVERIFIED', false),
  ('00000000-0000-0000-0000-000000000104', '2026-11-03T10:00:00Z', now(), null, 'API', 'key-a', null,                                    true,  null,         false),
  ('00000000-0000-0000-0000-000000000105', '2026-11-03T11:00:00Z', now(), now(), 'MANUAL', 'A', '00000000-0000-0000-0000-0000000000a1', true, 'VERIFIED',  false),
  ('00000000-0000-0000-0000-000000000201', '2026-11-03T10:00:00Z', now(), null, 'MANUAL', 'B', '00000000-0000-0000-0000-0000000000b1', true,  'VERIFIED',   false),
  ('00000000-0000-0000-0000-000000000202', '2026-11-03T10:00:00Z', now(), null, 'API', 'key-b', null,                                    true,  'VERIFIED',   false);

select is((public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') ->> 'total')::int, 4,
  'a member''s people: by their workspace member or their key, never a deleted row or another member''s');
select is((public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') ->> 'withEmail')::int, 3, 'with an email');
select is((public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') ->> 'verified')::int, 2, 'verified needs an email and VERIFIED');
select is((public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') ->> 'sendable')::int, 1, 'sendable also needs no not-sendable flag');
select is((public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') ->> 'unverified')::int, 2, 'unverified counts a missing verification');
select is(jsonb_array_length(public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') -> 'added'), 3,
  'added lists only the people created since the window start');
select is((public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') -> 'added' ->> 0)::bigint,
  extract(epoch from timestamptz '2026-11-01T10:00:00Z')::bigint, 'added is creation time in epoch seconds, oldest first');
select is(public.gtm_team_people_summary('00000000-0000-0000-0000-0000000000a1', array['key-a'], '2026-10-01T00:00:00Z') -> 'latest' -> 0 ->> 'id',
  '00000000-0000-0000-0000-000000000104', 'latest is newest first');
select is((public.gtm_team_people_summary(null, array['key-b'], '2026-10-01T00:00:00Z') ->> 'total')::int, 1, 'a member with only a key name');
select is((public.gtm_team_people_summary(null, '{}', '2026-10-01T00:00:00Z') ->> 'total')::int, 0, 'no identity matches nobody');

select is((select count(*)::int from public.gtm_team_people_lookup('00000000-0000-0000-0000-0000000000a1', array['key-a'],
  array['00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000105',
        '00000000-0000-0000-0000-000000000201']::uuid[])), 2, 'lookup keeps only the member''s live people among the ids');

-- Access
select pg_temp.as_role('authenticated', true);
select is((select count(*)::int from public.gtm_crm_people where id::text like '00000000-0000-0000-0000-0000000001%' or id::text like '00000000-0000-0000-0000-0000000002%'), 7, 'an owner reads the mirror');
select throws_ok($$insert into public.gtm_crm_people (id, created_at, updated_at) values (gen_random_uuid(), now(), now())$$, '42501', null, 'an owner cannot write it');
select throws_ok($$select public.gtm_team_people_summary(null, '{}', now())$$, '42501', null, 'the summary is for the service role');
select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_crm_people), 0, 'a signed-in non-owner reads nothing');
select pg_temp.as_role('anon', null);
select throws_ok($$select count(*) from public.gtm_crm_people$$, '42501', null, 'anon reads nothing');

select * from finish();
rollback;
