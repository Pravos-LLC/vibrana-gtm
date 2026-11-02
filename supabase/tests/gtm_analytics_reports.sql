-- Behaviour tests for 20261102010000_gtm_analytics_reports.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_analytics_reports.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
select lives_ok($$insert into public.gtm_analytics_reports (kind, slug, period_start, period_end, title, headline, doc)
  values ('weekly', 'weekly-2026-10-26', '2026-10-26', '2026-11-01', 'Week 4', 'Indigenous clips carry Instagram', '{"version": 1}')$$,
  'the service role publishes a report');
select throws_ok($$insert into public.gtm_analytics_reports (kind, slug, period_start, period_end, title, headline, doc)
  values ('weekly', 'weekly-2026-10-26-b', '2026-10-26', '2026-11-01', 'Again', 'Again', '{}')$$,
  '23505', null, 'one weekly report per period start');
select lives_ok($$insert into public.gtm_analytics_reports (kind, slug, period_start, period_end, title, headline, doc)
  values ('weekly', 'weekly-2026-10-26', '2026-10-26', '2026-11-01', 'Week 4 v2', 'Rewritten', '{}')
  on conflict (kind, period_start) do update set title = excluded.title, headline = excluded.headline, doc = excluded.doc, updated_at = now()$$,
  'republishing a week upserts it');
select is((select title from public.gtm_analytics_reports where slug = 'weekly-2026-10-26'), 'Week 4 v2', 'the upsert kept the new title');
select throws_ok($$insert into public.gtm_analytics_reports (kind, slug, period_start, period_end, title, headline, doc)
  values ('weekly', 'weekly-x', '2026-10-26', '2026-10-20', 'Bad', 'Bad', '{}')$$, '23514', null, 'the period cannot end before it starts');
select throws_ok($$insert into public.gtm_analytics_reports (kind, slug, period_start, period_end, title, headline, doc)
  values ('weekly', 'Weekly X', '2026-11-02', '2026-11-08', 'Bad', 'Bad', '{}')$$, '23514', null, 'the slug is lowercase and URL-safe');
select throws_ok($$insert into public.gtm_analytics_reports (kind, slug, period_start, period_end, title, headline, doc)
  values ('weekly', 'weekly-2026-11-02', '2026-11-02', '2026-11-08', 'Bad', 'Bad', '[]')$$, '23514', null, 'the document is a JSON object');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_analytics_reports$$, '42501', null, 'anonymous cannot read reports');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_analytics_reports), 0::bigint, 'a signed-in non-owner reads no reports');

select pg_temp.as_role('authenticated', true);
select is((select count(*) from public.gtm_analytics_reports), 1::bigint, 'the owner reads the report');

select * from finish();
rollback;
