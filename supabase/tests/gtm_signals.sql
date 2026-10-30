-- Behaviour tests for 20261005200000_gtm_signals.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_signals.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_signal_stories (id, title, lanes) values ('00000000-0000-0000-0000-0000000000c1', 'Grid strain', '{power,datacenters}');
select lives_ok($$insert into public.gtm_signal_items (url, source, source_kind, title, story_id)
  values ('https://example.com/a', 'DCD', 'rss', 'A', '00000000-0000-0000-0000-0000000000c1')$$, 'an item joins a story');
select throws_ok($$insert into public.gtm_signal_items (url, source, source_kind, title)
  values ('https://example.com/a', 'DCD', 'rss', 'Again')$$, '23505', null, 'an item URL is seen once');
select throws_ok($$insert into public.gtm_signal_items (url, source, source_kind, title)
  values ('ftp://example.com/b', 'DCD', 'rss', 'B')$$, '23514', null, 'item URLs are http(s)');
select throws_ok($$insert into public.gtm_signal_items (url, source, source_kind, title)
  values ('https://example.com/c', 'DCD', 'telegram', 'C')$$, '23514', null, 'only known source kinds');
select throws_ok($$insert into public.gtm_signal_stories (title, lanes) values ('Bad lane', '{Power}')$$,
  '23514', null, 'lane slugs are lowercase');
select throws_ok($$update public.gtm_signal_stories set status = 'queued' where id = '00000000-0000-0000-0000-0000000000c1'$$,
  '23514', null, 'a queued story names the format to make');
select lives_ok($$update public.gtm_signal_stories set status = 'queued', requested_format = 'repost' where id = '00000000-0000-0000-0000-0000000000c1'$$,
  'a story is queued as a repost');
select throws_ok($$insert into public.gtm_signal_feedback (story_id, actor, action) values ('00000000-0000-0000-0000-0000000000c1', 'x', 'love')$$,
  '23514', null, 'only known feedback actions');
select lives_ok($$insert into public.gtm_signal_runs (kind, stats) values ('collect', '{"rss": 12}')$$, 'a run records its counts');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_signal_stories$$, '42501', null, 'anonymous cannot read signal stories');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_signal_stories), 0::bigint, 'a signed-in non-owner reads no signal stories');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) >= 1 from public.gtm_signal_stories), 'owner reads signal stories');
select ok((select count(*) >= 1 from public.gtm_signal_items), 'owner reads signal items');
select throws_ok($$update public.gtm_signal_stories set status = 'dismissed'$$, '42501', null, 'nobody updates a signal story directly');

select * from finish();
rollback;
