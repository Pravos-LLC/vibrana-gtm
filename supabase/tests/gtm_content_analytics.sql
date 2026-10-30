-- Behaviour tests for 20261011130000_gtm_content_analytics.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_content_analytics.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);

-- One snapshot per post, platform and UTC day: a second run the same day updates it.
insert into public.gtm_post_metrics (zernio_post_id, platform, captured_at, likes)
  values ('t-post', 'linkedin', '2026-10-10T06:00:00Z', 3);
select is((select captured_on from public.gtm_post_metrics where zernio_post_id = 't-post'), '2026-10-10'::date,
  'captured_on is the UTC day of captured_at');
select throws_ok($$insert into public.gtm_post_metrics (zernio_post_id, platform, captured_at) values ('t-post', 'linkedin', '2026-10-10T20:00:00Z')$$,
  '23505', null, 'a second plain insert the same UTC day is refused');
select lives_ok($$insert into public.gtm_post_metrics (zernio_post_id, platform, captured_at, likes, extras)
  values ('t-post', 'linkedin', '2026-10-10T20:00:00Z', 5, '{"sends": 2}')
  on conflict (zernio_post_id, platform, captured_on) do update set captured_at = excluded.captured_at, likes = excluded.likes, extras = excluded.extras$$,
  'the sync upserts on (post, platform, day)');
select is((select count(*) from public.gtm_post_metrics where zernio_post_id = 't-post'), 1::bigint, 'still one row for that day');
select is((select likes from public.gtm_post_metrics where zernio_post_id = 't-post'), 5, 'the upsert kept the newer numbers');
select lives_ok($$insert into public.gtm_post_metrics (zernio_post_id, platform, captured_at) values ('t-post', 'linkedin', '2026-10-11T00:30:00Z')$$,
  'the next UTC day gets its own snapshot');
select is((select count(*) from public.gtm_post_metrics where zernio_post_id = 't-post' and platform = 'linkedin'), 2::bigint, 'two days, two rows');
select is((select extras ->> 'sends' from public.gtm_post_metrics_latest where zernio_post_id = 't-post'), null,
  'the latest view carries the extras column (the newest row has none)');
select throws_ok($$insert into public.gtm_post_metrics (zernio_post_id, platform, captured_at, extras) values ('t-x', 'linkedin', now(), '[]')$$,
  '23514', null, 'extras is a JSON object');
select throws_ok($$insert into public.gtm_post_metrics (zernio_post_id, platform, captured_at, captured_on) values ('t-y', 'linkedin', now(), '2026-01-01')$$,
  '428C9', null, 'captured_on cannot be written: it always follows captured_at');

-- Manual weekly metrics: Monday-keyed, one row per channel and week.
select throws_ok($$insert into public.gtm_manual_metrics (week_start, channel) values ('2001-01-03', 'youtube')$$,
  '23514', null, 'a manual week starts on a Monday');
select lives_ok($$insert into public.gtm_manual_metrics (week_start, channel, metrics) values ('2001-01-01', 'substack_regenera', '{"subscribers": 812}')$$,
  'a Substack week is recorded');

-- Reports and their actions.
insert into public.gtm_content_items (id, week, date, pillar, title, format, status)
  values ('t-item', 42, '2026-10-14', 'proof', 'T', 'carousel', 'drafted');
insert into public.gtm_content_reports (id, kind, period_start, period_end)
  values ('00000000-0000-0000-0000-0000000000e1', 'weekly', '2001-01-01', '2001-01-07');
select throws_ok($$insert into public.gtm_content_reports (kind, period_start, period_end) values ('weekly', '2001-01-01', '2001-01-07')$$,
  '23505', null, 'one weekly report per week');
select throws_ok($$insert into public.gtm_content_reports (kind, period_start, period_end) values ('monthly', '2001-01-01', '2001-01-07')$$,
  '23514', null, 'only known report kinds');
select lives_ok($$insert into public.gtm_report_actions (report_id, type, item_id, change, proposal)
  values ('00000000-0000-0000-0000-0000000000e1', 'move', 't-item', '{"date": "2026-10-15"}', 'Move it a day')$$,
  'a report proposes a move');
select throws_ok($$update public.gtm_report_actions set status = 'accepted' where item_id = 't-item'$$,
  '23514', null, 'a decided action records when it was decided');
select throws_ok($$insert into public.gtm_report_actions (report_id, type, proposal) values ('00000000-0000-0000-0000-0000000000e1', 'publish', 'x')$$,
  '23514', null, 'a report can never propose publishing');

-- An accepted swap: both items trade date and time in one statement, or nothing moves.
insert into public.gtm_content_items (id, week, date, time, pillar, title, format, status)
  values ('t-a', 42, '2026-10-14', '08:30', 'proof', 'A', 'carousel', 'drafted'), ('t-b', 2, '2027-01-05', null, 'build', 'B', 'video', 'approved');
insert into public.gtm_content_items (id, week, date, pillar, title, format, status, zernio_post_id)
  values ('t-sched', 42, '2026-10-16', 'lists', 'S', 'document', 'scheduled', 'zp-1');
select lives_ok($$select public.gtm_swap_slots('t-a', 't-b')$$, 'two unscheduled items swap');
select results_eq($$select id, date, time, week from public.gtm_content_items where id in ('t-a', 't-b') order by id$$,
  $$values ('t-a'::text, '2027-01-05'::date, null::text, 1), ('t-b'::text, '2026-10-14'::date, '08:30'::text, 42)$$,
  'dates, times and ISO weeks traded');
select throws_ok($$select public.gtm_swap_slots('t-a', 't-sched')$$, '55000', null, 'a scheduled item refuses the whole swap');
select is((select date from public.gtm_content_items where id = 't-a'), '2027-01-05'::date, 'and nothing moved');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_content_reports$$, '42501', null, 'anonymous cannot read reports');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_report_actions), 0::bigint, 'a signed-in non-owner reads no report actions');

select pg_temp.as_role('authenticated', true);
select throws_ok($$select public.gtm_swap_slots('t-a', 't-b')$$, '42501', null, 'even the owner cannot call the swap directly');
select throws_ok($$update public.gtm_report_actions set status = 'dismissed', decided_at = now()$$, '42501', null,
  'the owner decides actions through the cockpit server, never directly');

select * from finish();
rollback;
