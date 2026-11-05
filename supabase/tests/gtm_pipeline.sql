-- Behaviour tests for 20261105030000_gtm_pipeline.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_pipeline.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
select lives_ok($$insert into public.gtm_deal_milestones (opportunity_id, label, amount, currency, due_on)
  values ('00000000-0000-0000-0000-0000000000d1', 'Deposit (50%)', 5000, 'USD', current_date)$$, 'the service role records a milestone');
select throws_ok($$insert into public.gtm_deal_milestones (opportunity_id, label, amount, currency)
  values ('00000000-0000-0000-0000-0000000000d1', 'Deposit (50%)', 5000, 'USD')$$, '23505', null, 'a milestone label is unique per deal');
select throws_ok($$insert into public.gtm_deal_milestones (opportunity_id, label, amount, currency)
  values ('00000000-0000-0000-0000-0000000000d1', 'Demo', 2500, 'usd')$$, '23514', null, 'currency is an upper-case ISO code');
select throws_ok($$update public.gtm_deal_milestones set paid_at = now() where label = 'Deposit (50%)'$$,
  '23514', null, 'a paid milestone needs the amount received');
select lives_ok($$update public.gtm_deal_milestones set paid_at = now(), paid_amount = 5000 where label = 'Deposit (50%)'$$,
  'a milestone is marked paid with the amount received');
select lives_ok($$update public.gtm_deal_milestones set payment_ref = 'wise:TRANSFER-1' where label = 'Deposit (50%)'$$, 'a paid milestone records its Wise credit');
select throws_ok($$insert into public.gtm_deal_milestones (opportunity_id, label, amount, currency, paid_at, paid_amount, payment_ref)
  values ('00000000-0000-0000-0000-0000000000d1', 'Final', 5000, 'USD', now(), 5000, 'wise:TRANSFER-1')$$, '23505', null, 'one Wise credit cannot pay two milestones');
select lives_ok($$insert into public.gtm_deal_stage_history (opportunity_id, stage) values ('00000000-0000-0000-0000-0000000000d1', 'PROPOSAL')$$,
  'the sync records the first time a deal is seen at a stage');
select throws_ok($$insert into public.gtm_deal_stage_history (opportunity_id, stage) values ('00000000-0000-0000-0000-0000000000d1', 'PROPOSAL')$$,
  '23505', null, 'a stage is recorded once per deal');
select lives_ok($$insert into public.gtm_linkedin_connections (owner, profile_hash, connected_on, icp) values ('JOHN', repeat('a', 64), current_date, true)$$,
  'the importer records a connection as a hash');
select throws_ok($$insert into public.gtm_linkedin_connections (owner, profile_hash, connected_on) values ('JOHN', 'https://www.linkedin.com/in/someone', current_date)$$,
  '23514', null, 'a raw profile URL is refused');
select lives_ok($$insert into public.gtm_linkedin_threads (owner, thread_hash, first_at, last_at, started_by_owner, two_way, messages, owner_messages)
  values ('JOHN', repeat('b', 64), now() - interval '1 day', now(), true, true, 3, 2)$$, 'the importer records thread metadata');
select throws_ok($$insert into public.gtm_linkedin_threads (owner, thread_hash, first_at, last_at, started_by_owner, two_way, messages, owner_messages)
  values ('JOHN', repeat('c', 64), now(), now(), true, false, 1, 2)$$, '23514', null, 'the owner cannot have sent more messages than the thread has');
select lives_ok($$insert into public.gtm_web_daily (site, day, visitors, pageviews) values ('vibrana.ai', current_date, 10, 25)$$,
  'the sync records a site day');
insert into public.gtm_outreach_drafts (id, batch, domain, subject, body)
  values ('00000000-0000-0000-0000-0000000000f8', 'pipeline-test', 'seed.example', 'Subject', 'Body');
select lives_ok($$update public.gtm_outreach_drafts set email_replied_at = now(), reply_sentiment = 'positive', reply_labeled_at = now()
  where id = '00000000-0000-0000-0000-0000000000f8'$$, 'a reply is recorded and John labels it');
select throws_ok($$update public.gtm_outreach_drafts set reply_sentiment = 'great' where id = '00000000-0000-0000-0000-0000000000f8'$$,
  '23514', null, 'only the five reply labels are stored');

select pg_temp.as_role('anon', null);
select throws_ok($$select id from public.gtm_deal_milestones$$, '42501', null, 'anonymous cannot read milestones');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_deal_milestones), 0::bigint, 'a signed-in non-owner reads no milestones');

select pg_temp.as_role('authenticated', true);
select is((select count(*) from public.gtm_deal_milestones), 1::bigint, 'the owner reads the milestones');

select * from finish();
rollback;
