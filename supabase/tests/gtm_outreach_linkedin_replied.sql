-- Behaviour tests for 20261111010000_gtm_outreach_linkedin_replied.sql (replies on the warm streams, marked on the desk, VIB-522).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_outreach_linkedin_replied.sql   (also `supabase test db`)
-- Synthetic data only: .example domains and made-up names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

set local role service_role;

select has_column('public', 'gtm_outreach_drafts', 'linkedin_replied_at', 'drafts record when a LinkedIn note was answered');
select has_column('public', 'gtm_outreach_drafts', 'email_reply_dismissed_at', 'drafts record when an email reply was cleared by hand');
insert into public.gtm_outreach_drafts (id, batch, domain, variant, person, track, route, status, decided_by, decided_at, linkedin_note)
values ('00000000-0000-4000-8000-0000000000f7', 'desk', 'rae-example.network.invalid', 'john', '00000000-0000-4000-8000-00000000a007', 'network', 'linkedin', 'accepted', 'john', now(), 'Hi Rae');
select throws_ok($$update public.gtm_outreach_drafts set linkedin_replied_at = now() where id = '00000000-0000-4000-8000-0000000000f7'$$,
  '23514', null, 'a reply needs a sent note');
update public.gtm_outreach_drafts set linkedin_status = 'sent' where id = '00000000-0000-4000-8000-0000000000f7';
select lives_ok($$update public.gtm_outreach_drafts set linkedin_replied_at = now() where id = '00000000-0000-4000-8000-0000000000f7'$$, 'a sent note can be marked replied');
select is((select email_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000f7'), null, 'a LinkedIn reply stamps no email send');
select lives_ok($$update public.gtm_outreach_drafts set linkedin_status = 'connected' where id = '00000000-0000-4000-8000-0000000000f7'$$,
  'an accepted invite (connected) keeps its reply');
select throws_ok($$update public.gtm_outreach_drafts set linkedin_status = 'skipped' where id = '00000000-0000-4000-8000-0000000000f7'$$,
  '23514', null, 'a skipped note cannot carry a reply');
select throws_ok($$update public.gtm_outreach_drafts set linkedin_status = 'none' where id = '00000000-0000-4000-8000-0000000000f7'$$,
  '23514', null, 'the note cannot be un-sent while its reply is marked');
select lives_ok($$update public.gtm_outreach_drafts set linkedin_status = 'none', linkedin_sent_at = null, linkedin_replied_at = null where id = '00000000-0000-4000-8000-0000000000f7'$$,
  'clearing the reply with the note is allowed');
select lives_ok($$update public.gtm_outreach_drafts set email_reply_dismissed_at = now() where id = '00000000-0000-4000-8000-0000000000f7'$$,
  'a dismissal is a plain time, on any draft');
select is((select email_status from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000f7'), 'none', 'a dismissal changes no status');

select * from finish();
rollback;
