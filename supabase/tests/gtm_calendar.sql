-- Behaviour tests for 20261002120000_gtm_calendar_db.sql.
-- Run against a non-production database with the migration applied:
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_calendar.sql
-- Also runs under `supabase test db` (CI `database` job). Every expectation is a TAP assertion
-- (ok / throws_ok with the expected SQLSTATE / lives_ok), counted by plan().
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

-- ---- columns -----------------------------------------------------------------------
select has_column('public', 'gtm_content_items', 'publication', 'content items have publication');
select has_column('public', 'gtm_content_items', 'body', 'content items have body');
select col_type_is('public', 'gtm_content_items', 'media', 'jsonb', 'media is jsonb');
select has_column('public', 'gtm_content_items', 'approved_hash', 'content items have approved_hash');
select col_type_is('public', 'gtm_content_items', 'story_assets', 'text[]', 'story_assets is text[]');
select has_column('public', 'gtm_content_items', 'copy_path', 'content items have copy_path');
select has_column('public', 'gtm_content_items', 'created_at', 'content items have created_at');

select pg_temp.as_role('service_role', null);

-- ---- time / pillar / publication checks ----------------------------------------------
select throws_ok($$insert into public.gtm_content_items (id, week, date, time, pillar, title, format, status)
  values ('t-quoted', 40, '2026-10-02', '"15:00"', 'proof', 'T', 'text', 'drafted')$$,
  '23514', null, 'YAML-escaped time is rejected');
select throws_ok($$insert into public.gtm_content_items (id, week, date, time, pillar, title, format, status)
  values ('t-25', 40, '2026-10-02', '25:00', 'proof', 'T', 'text', 'drafted')$$,
  '23514', null, 'out-of-range time is rejected');
select lives_ok($$insert into public.gtm_content_items (id, week, date, time, pillar, title, format, status, publication, body, approved_hash)
  values ('t-ok', 40, '2026-10-02', '15:00', 'proof', 'T', 'text', 'approved', 'regenera', 'First body', repeat('a', 64))$$,
  'HH:MM time is accepted');
select throws_ok($$insert into public.gtm_content_items (id, week, date, pillar, title, format, status)
  values ('t-pillar', 40, '2026-10-02', 'misc', 'T', 'text', 'drafted')$$,
  '23514', null, 'unknown pillar is rejected');
select throws_ok($$insert into public.gtm_content_items (id, week, date, pillar, title, format, status, publication)
  values ('t-pub', 40, '2026-10-02', 'proof', 'T', 'text', 'drafted', 'medium')$$,
  '23514', null, 'unknown publication is rejected');

-- ---- approval trigger ------------------------------------------------------------------
update public.gtm_content_items set body = 'Edited body' where id = 't-ok';
select ok((select approved_hash is null and status = 'drafted' from public.gtm_content_items where id = 't-ok'),
  'editing the body clears approval and returns the item to drafted');

update public.gtm_content_items set status = 'approved', approved_hash = repeat('b', 64) where id = 't-ok';
update public.gtm_content_items set media = '["stories/x/a.jpg"]' where id = 't-ok';
select ok((select approved_hash is null and status = 'drafted' from public.gtm_content_items where id = 't-ok'),
  'changing media clears approval');

update public.gtm_content_items set status = 'approved', body = 'Approved body', approved_hash = repeat('c', 64) where id = 't-ok';
select ok((select approved_hash = repeat('c', 64) and status = 'approved' from public.gtm_content_items where id = 't-ok'),
  'an update that records a new digest keeps the approval');

update public.gtm_content_items set title = 'Retitled' where id = 't-ok';
select ok((select approved_hash = repeat('c', 64) and status = 'approved' from public.gtm_content_items where id = 't-ok'),
  'non-content edits keep the approval');

-- ---- gtm_inspiration RLS ----------------------------------------------------------------
-- Start from a known-empty table (rolled back with the transaction) so counts hold on a seeded database too.
delete from public.gtm_inspiration;
insert into public.gtm_inspiration (kind, url, title, tags, pillar)
  values ('video', 'https://www.youtube.com/watch?v=YsZ-lx_3eoM', 'Vox reference', '{motion-graphics}', 'perspective');
select throws_ok($$insert into public.gtm_inspiration (kind, url) values ('podcast', 'https://example.test/p')$$,
  '23514', null, 'unknown inspiration kind is rejected');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_inspiration$$, '42501', null, 'anonymous cannot read inspiration');

select pg_temp.as_role('authenticated', false);
select ok((select count(*) from public.gtm_inspiration) = 0, 'non-owner reads no inspiration');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) from public.gtm_inspiration) = 1, 'owner reads inspiration');
select throws_ok($$insert into public.gtm_inspiration (kind, url) values ('post', 'https://example.test/owner')$$,
  '42501', null, 'owner cannot insert inspiration directly');

reset role;
select * from finish();
rollback;
