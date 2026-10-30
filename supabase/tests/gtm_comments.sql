-- Behaviour tests for 20261011120000_gtm_comments.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_comments.sql   (also `supabase test db`)
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
select lives_ok($$insert into public.gtm_comments (id, source, platform, account_id, platform_post_id, external_id, author_name, text)
  values ('00000000-0000-0000-0000-0000000000d1', 'webhook', 'instagram', 'acc', 'p1', 'c1', 'Ana', 'How did you measure that?')$$,
  'a comment is stored');
select throws_ok($$insert into public.gtm_comments (source, platform, external_id, text) values ('poll', 'instagram', 'c1', 'again')$$,
  '23505', null, 'a platform comment is stored once');
select lives_ok($$insert into public.gtm_comments (source, platform, kind, external_id, conversation_id, text)
  values ('webhook', 'instagram', 'dm', 'c1', 'conv1', 'a DM with the same id')$$, 'a DM and a comment have separate id spaces');
select throws_ok($$insert into public.gtm_comments (source, platform, kind, external_id, text) values ('webhook', 'instagram', 'dm', 'm2', 'x')$$,
  '23514', null, 'a DM names its conversation');
select throws_ok($$insert into public.gtm_comments (source, platform, external_id, text) values ('fax', 'instagram', 'c3', 'x')$$,
  '23514', null, 'only known sources');
select throws_ok($$insert into public.gtm_comments (source, platform, external_id, text, permalink) values ('poll', 'instagram', 'c4', 'x', 'javascript:alert(1)')$$,
  '23514', null, 'links are http(s)');
select throws_ok($$update public.gtm_comments set status = 'sent' where id = '00000000-0000-0000-0000-0000000000d1'$$,
  '23514', null, 'a sent reply records when it was sent');
update public.gtm_comments set draft = 'We counted lessons completed per person.', status = 'drafted', classification = 'reply'
  where id = '00000000-0000-0000-0000-0000000000d1';
update public.gtm_comments set final_text = 'We counted lessons completed per person, weekly.', status = 'sent', sent_at = now()
  where id = '00000000-0000-0000-0000-0000000000d1';
select is((select edited from public.gtm_comments where id = '00000000-0000-0000-0000-0000000000d1'), true, 'an edited draft is marked edited');
select lives_ok($$insert into public.gtm_comment_runs (kind, stats) values ('daily', '{"drafted": 3}')$$, 'a run records its counts');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_comments$$, '42501', null, 'anonymous cannot read comments');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_comments), 0::bigint, 'a signed-in non-owner reads no comments');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) >= 1 from public.gtm_comments), 'owner reads comments');
select ok((select count(*) >= 1 from public.gtm_comment_runs), 'owner reads comment runs');
select throws_ok($$update public.gtm_comments set status = 'skipped'$$, '42501', null, 'nobody updates a comment directly');

select * from finish();
rollback;
