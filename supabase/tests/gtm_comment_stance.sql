-- Behaviour tests for 20261011170000_gtm_comment_stance.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_comment_stance.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_comments (id, source, platform, external_id, text)
  values ('00000000-0000-0000-0000-0000000000d7', 'poll', 'linkedin', 'stance-1', 'This misses the point about cost.');
select lives_ok($$update public.gtm_comments set stance = 'constructive_dissent', objection = 'cost is ignored', stance_at = now(), author_crm = 'icp', author_followers = 120, author_verified = false
  where id = '00000000-0000-0000-0000-0000000000d7'$$, 'a comment records its stance, objection and who-signals');
select throws_ok($$update public.gtm_comments set stance = 'angry' where id = '00000000-0000-0000-0000-0000000000d7'$$, '23514', null, 'only known stances');
select throws_ok($$update public.gtm_comments set author_crm = 'vip' where id = '00000000-0000-0000-0000-0000000000d7'$$, '23514', null, 'only known CRM match levels');
select throws_ok($$update public.gtm_comments set author_followers = -1 where id = '00000000-0000-0000-0000-0000000000d7'$$, '23514', null, 'follower counts are not negative');
select throws_ok($$update public.gtm_comments set objection = repeat('x', 301) where id = '00000000-0000-0000-0000-0000000000d7'$$, '23514', null, 'the objection is one line');
select lives_ok($$insert into public.gtm_red_flag_alerts (post_key, flag, stats) values ('linkedin|urn:li:activity:1', 'backlash', '{"negative": 3}')$$, 'an alert is recorded');
select throws_ok($$insert into public.gtm_red_flag_alerts (post_key, flag) values ('linkedin|x', 'meltdown')$$, '23514', null, 'only known flags');
select isnt(public.gtm_claim_red_flag_alert('instagram|claim-1', 'backlash', 24, '{"via": "webhook"}'), null, 'the first claim for a post wins');
select is(public.gtm_claim_red_flag_alert('instagram|claim-1', 'backlash', 24), null, 'a second claim inside the cooldown gets nothing');
select isnt(public.gtm_claim_red_flag_alert('instagram|claim-2', 'backlash', 24), null, 'another post claims independently');
select throws_ok($$select public.gtm_claim_red_flag_alert('instagram|claim-3', 'backlash', 0)$$, '22023', null, 'the cooldown is at least an hour');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_red_flag_alerts$$, '42501', null, 'anonymous cannot read alerts');
select throws_ok($$select public.gtm_claim_red_flag_alert('instagram|anon', 'backlash', 24)$$, '42501', null, 'anonymous cannot claim an alert');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_red_flag_alerts), 0::bigint, 'a signed-in non-owner reads no alerts');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) >= 1 from public.gtm_red_flag_alerts), 'owner reads alerts');
select throws_ok($$delete from public.gtm_red_flag_alerts$$, '42501', null, 'nobody deletes an alert directly');
select throws_ok($$select public.gtm_claim_red_flag_alert('instagram|owner', 'backlash', 24)$$, '42501', null, 'even the owner claims only through the server');

select * from finish();
rollback;
