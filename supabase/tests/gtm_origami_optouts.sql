-- Behaviour tests for 20261110020000_gtm_origami_optouts.sql (VIB-521).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_origami_optouts.sql   (also `supabase test db`)
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
select lives_ok($$insert into public.gtm_origami_replies (evidence_key, kind, source, origami_reply_id, sequence_id, campaign_id, channel, received_at,
    body_hash, rule_version, classification, reason, first_on_sequence)
  values ('reply:00000000-0000-4000-8000-00000000a001:2026-11-10T09:59:58.123Z', 'reply', 'poll', '00000000-0000-4000-8000-00000000e001',
    '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000c001', 'email', '2026-11-10T09:59:58.123Z',
    repeat('h', 32), 'origami-reply-v1', 'confirmed', 'exact_phrase', true)$$, 'the service role records a judged reply, its body as a hash only');
select throws_ok($$insert into public.gtm_origami_replies (evidence_key, kind, source, sequence_id, received_at, rule_version, classification, reason)
  values ('reply:00000000-0000-4000-8000-00000000a001:2026-11-10T09:59:58.123Z', 'reply', 'webhook', '00000000-0000-4000-8000-00000000a001', now(), 'origami-reply-v1', 'confirmed', 'exact_phrase')$$,
  '23505', null, 'the same evidence is recorded once, whichever path sees it');
select throws_ok($$insert into public.gtm_origami_replies (evidence_key, kind, source, sequence_id, received_at, rule_version, classification, reason)
  values ('reply:ana@prospect.test', 'reply', 'webhook', '00000000-0000-4000-8000-00000000a002', now(), 'origami-reply-v1', 'possible', 'leading_no')$$,
  '23514', null, 'an evidence key holds ids and a time, never an address');
select throws_ok($$insert into public.gtm_origami_replies (evidence_key, kind, source, sequence_id, received_at, rule_version, classification, reason, body_hash)
  values ('status:00000000-0000-4000-8000-00000000a003', 'unsubscribed_status', 'status_scan', '00000000-0000-4000-8000-00000000a003', now(), 'origami-reply-v1', 'confirmed', 'origami_unsubscribed', 'No thanks')$$,
  '23514', null, 'a reply body cannot be stored in the hash column');
select throws_ok($$insert into public.gtm_origami_replies (evidence_key, kind, source, sequence_id, received_at, rule_version, classification, reason, match)
  values ('status:00000000-0000-4000-8000-00000000a004', 'unsubscribed_status', 'status_scan', '00000000-0000-4000-8000-00000000a004', now(), 'origami-reply-v1', 'confirmed', 'origami_unsubscribed', 'matched')$$,
  '23514', null, 'a matched row names its Twenty person');
select throws_ok($$insert into public.gtm_origami_replies (evidence_key, kind, source, sequence_id, received_at, rule_version, classification, reason, match)
  values ('status:00000000-0000-4000-8000-00000000a005', 'unsubscribed_status', 'status_scan', '00000000-0000-4000-8000-00000000a005', now(), 'origami-reply-v1', 'none', 'no_opt_out', 'pending')$$,
  '23514', null, 'a reply with no opt-out needs no match');

select lives_ok($$insert into public.gtm_email_reply_labels (origami_reply_id, source, intent, opt_out, decision_version)
  values ((select id from public.gtm_origami_replies where origami_reply_id = '00000000-0000-4000-8000-00000000e001'), 'deterministic', 'not_interested', 'person', 1)$$,
  'a decision can be about an Origami reply');
select throws_ok($$insert into public.gtm_email_reply_labels (origami_reply_id, source, intent, opt_out)
  values ((select id from public.gtm_origami_replies where origami_reply_id = '00000000-0000-4000-8000-00000000e001'), 'deterministic', 'uncertain', 'uncertain')$$,
  '23505', null, 'one current decision per source and Origami reply');
select throws_ok($$insert into public.gtm_email_reply_labels (source, intent) values ('deterministic', 'neutral')$$, '23514', null, 'a decision still names what it is about');
select throws_ok($$delete from public.gtm_origami_replies where origami_reply_id = '00000000-0000-4000-8000-00000000e001'$$, '23503', null, 'evidence behind a decision cannot be deleted');

select lives_ok($$insert into public.gtm_email_sync_ops (op_key, destination, action, reason, policy_version, observed_at, state, approved_at, approval_ref, origami_campaign_id, origami_sequence_id, evidence_ref)
  values ('stop:00000000-0000-4000-8000-00000000c001:00000000-0000-4000-8000-00000000a001', 'origami', 'sequence_stop', 'UNSUBSCRIBED', 'origami-reply-v1', now(), 'approved', now(), 'auto',
    '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001', 'an Origami email reply received 2026-11-10T09:59:58.123Z')$$,
  'a stop of an unmatched person names its campaign and sequence');
select throws_ok($$insert into public.gtm_email_sync_ops (op_key, destination, action, reason, policy_version, observed_at, origami_campaign_id)
  values ('stop:missing-sequence', 'origami', 'sequence_stop', 'UNSUBSCRIBED', 'origami-reply-v1', now(), '00000000-0000-4000-8000-00000000c001')$$,
  '23514', null, 'a stop without its sequence is refused');
select throws_ok($$insert into public.gtm_email_sync_ops (op_key, destination, action, reason, policy_version, observed_at, origami_campaign_id, origami_sequence_id)
  values ('stop:twenty-destination', 'twenty', 'sequence_stop', 'UNSUBSCRIBED', 'origami-reply-v1', now(), '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001')$$,
  '23514', null, 'only Origami stops a sequence');

select lives_ok($$insert into public.gtm_origami_webhook_deliveries (webhook_id, event) values ('msg_1', 'sequence.reply.received')$$, 'a delivery is recorded by its webhook-id');

select pg_temp.as_role('anon', null);
select throws_ok($$select id from public.gtm_origami_replies$$, '42501', null, 'anonymous cannot read Origami evidence');

select pg_temp.as_role('authenticated', true);
select is((select count(*) from public.gtm_origami_replies where sequence_id = '00000000-0000-4000-8000-00000000a001'), 1::bigint, 'the owner reads the evidence');
select throws_ok($$select webhook_id from public.gtm_origami_webhook_deliveries$$, '42501', null, 'not even the owner reads webhook deliveries');

select * from finish();
rollback;
