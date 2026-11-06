-- Behaviour tests for 20261104010000_gtm_team_performance.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_team_performance.sql   (also `supabase test db`)
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
select lives_ok($$insert into public.gtm_team_mailboxes (member, address, token_ciphertext) values ('ABE', 'abe@example.com', repeat('x', 60))$$,
  'the service role stores a sealed mailbox token');
select throws_ok($$insert into public.gtm_team_mailboxes (member, address, token_ciphertext) values ('ABE', 'Abe@Example.com', repeat('x', 60))$$,
  '23514', null, 'a mailbox address is stored lowercase');
select lives_ok($$insert into public.gtm_team_mail_events (member, gmail_message_id, thread_id, kind, at, person_ids, recipient_hashes, mailbox)
  values ('ABE', '18f0a1', '18f0a1', 'outreach', now(), '{p1}', '{h1}', 'abe@example.com')$$, 'the service role records an outreach send');
-- Since 20261106020000 a Gmail id is unique per mailbox (gtm_email_mailbox_identity.sql), not per member.
select throws_ok($$insert into public.gtm_team_mail_events (member, gmail_message_id, thread_id, kind, at, mailbox) values ('ABE', '18f0a1', '18f0a1', 'reply', now(), 'abe@example.com')$$,
  '23505', null, 'a Gmail message is counted once per mailbox');
select throws_ok($$insert into public.gtm_team_mail_events (member, gmail_message_id, thread_id, kind, at) values ('ABE', '18f0a2', '18f0a2', 'personal', now())$$,
  '23514', null, 'only the four event kinds are stored');
select lives_ok($$insert into public.gtm_team_stock_daily (member, date, metrics) values ('ABE', '2026-11-04', '{"sendable": 0}')$$, 'the service role writes a stock snapshot');
select lives_ok($$update public.gtm_outreach_drafts set email_sent_by = 'abe@example.com' where false$$, 'the desk can record who marked a send');

select pg_temp.as_role('anon', null);
select throws_ok($$select member from public.gtm_team_mailboxes$$, '42501', null, 'anonymous cannot read mailbox connections');
select throws_ok($$select id from public.gtm_team_mail_events$$, '42501', null, 'anonymous cannot read mail events');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_team_mail_events), 0::bigint, 'a signed-in non-owner reads no mail events');
select is((select count(*) from public.gtm_team_stock_daily), 0::bigint, 'a signed-in non-owner reads no snapshots');

select pg_temp.as_role('authenticated', true);
select is((select count(*) from public.gtm_team_mailboxes), 1::bigint, 'the owner sees the mailbox connection status');
select throws_ok($$select token_ciphertext from public.gtm_team_mailboxes$$, '42501', null, 'not even the owner can read the sealed token');
select is((select count(*) from public.gtm_team_mail_events), 1::bigint, 'the owner reads the mail events');

select * from finish();
rollback;
