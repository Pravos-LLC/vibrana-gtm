-- Behaviour tests for 20261111010000_gtm_outreach_linkedin_replied.sql (a LinkedIn note's reply, marked on the desk, VIB-522).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_outreach_linkedin_replied.sql   (also `supabase test db`)
-- Synthetic data only: .example domains and made-up names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

set local role service_role;

select has_column('public', 'gtm_outreach_drafts', 'linkedin_replied_at', 'drafts record when a LinkedIn note was answered');
insert into public.gtm_outreach_drafts (id, batch, domain, variant, person, track, route, status, decided_by, decided_at, linkedin_note)
values ('00000000-0000-4000-8000-0000000000f7', 'desk', 'rae-example.network.invalid', 'john', '00000000-0000-4000-8000-00000000a007', 'network', 'linkedin', 'accepted', 'john', now(), 'Hi Rae');
select throws_ok($$update public.gtm_outreach_drafts set linkedin_replied_at = now() where id = '00000000-0000-4000-8000-0000000000f7'$$,
  '23514', null, 'a reply needs a sent note');
update public.gtm_outreach_drafts set linkedin_status = 'sent' where id = '00000000-0000-4000-8000-0000000000f7';
select lives_ok($$update public.gtm_outreach_drafts set linkedin_replied_at = now() where id = '00000000-0000-4000-8000-0000000000f7'$$, 'a sent note can be marked replied');
select is((select email_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000f7'), null, 'a LinkedIn reply stamps no email send');
select throws_ok($$update public.gtm_outreach_drafts set linkedin_status = 'none' where id = '00000000-0000-4000-8000-0000000000f7'$$,
  '23514', null, 'the note cannot be un-sent while its reply is marked');
select lives_ok($$update public.gtm_outreach_drafts set linkedin_status = 'none', linkedin_sent_at = null, linkedin_replied_at = null where id = '00000000-0000-4000-8000-0000000000f7'$$,
  'clearing the reply with the note is allowed');

select * from finish();
rollback;
