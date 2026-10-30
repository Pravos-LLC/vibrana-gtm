-- Behaviour tests for 20261016230000_gtm_outreach_drafts.sql (cold outreach drafts reviewed in /outreach).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_outreach_drafts.sql   (also `supabase test db`)
-- Synthetic data only: example.test domains and made-up names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);
insert into public.gtm_outreach_drafts (id, batch, domain, variant, prospect, subject, body, original_subject, original_body, linkedin_note, model)
values
  ('00000000-0000-4000-8000-0000000000a1', 'b-test', 'acme.example', 'model-a', '{"first_name":"Ada","company":"Acme"}', 'S a', 'B a', 'S a', 'B a', 'Hi Ada', 'model-a'),
  ('00000000-0000-4000-8000-0000000000a2', 'b-test', 'acme.example', 'model-b', '{"first_name":"Ada","company":"Acme"}', 'S b', 'B b', 'S b', 'B b', 'Hi Ada', 'model-b'),
  ('00000000-0000-4000-8000-0000000000a3', 'b-test', 'other.example', 'main', '{}', 'S o', 'B o', 'S o', 'B o', '', 'model-a');

select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, variant) values ('b-test', 'acme.example', 'model-a')$$, '23505', null, '(batch, domain, variant) is unique');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain) values ('b-test', 'Not A Domain')$$, '23514', null, 'a domain is a lowercase hostname');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, linkedin_note) values ('b-test', 'x.example', repeat('a', 301))$$, '23514', null, 'a LinkedIn note is at most 300 characters');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, status) values ('b-test', 'x.example', 'sent')$$, '23514', null, 'status is one of the four');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, followups) values ('b-test', 'x.example', '{}')$$, '23514', null, 'follow-ups are an array');
select throws_ok($$update public.gtm_outreach_drafts set email_status = 'sent' where id = '00000000-0000-4000-8000-0000000000a3'$$, '23514', null, 'only an accepted draft is acted on');

-- A person's edit keeps the previous text as an "edited" version.
update public.gtm_outreach_drafts set body = 'B a, edited', edited_by = 'john', edited_at = now() where id = '00000000-0000-4000-8000-0000000000a1';
select results_eq($$select reason, body, actor, version from public.gtm_outreach_draft_versions where draft_id = '00000000-0000-4000-8000-0000000000a1'$$,
  $$values ('edited'::text, 'B a'::text, 'john'::text, 1)$$, 'an edit keeps the previous text, by whom');
update public.gtm_outreach_drafts set status = 'pending' where id = '00000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.gtm_outreach_draft_versions where draft_id = '00000000-0000-4000-8000-0000000000a1'), 1, 'a status change alone keeps no version');

-- Accept with an edit in the same call: the sibling variant is rejected, the edit is stored.
select results_eq($$select status, subject, edited_by from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000a2', 'john', 'S b, edited', null, null, null)$$,
  $$values ('accepted'::text, 'S b, edited'::text, 'john'::text)$$, 'accept stores the edit and accepts');
select results_eq($$select status, note, decided_by from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000a1'$$,
  $$values ('rejected'::text, 'other variant chosen'::text, 'john'::text)$$, 'the sibling variant is rejected');
select is((select status from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000a3'), 'pending', 'another prospect is untouched');
select throws_ok($$update public.gtm_outreach_drafts set status = 'accepted' where id = '00000000-0000-4000-8000-0000000000a1'$$, '23505', null, 'one accepted variant per prospect');

-- Switching to the other variant before anything was sent flips them; after a send it is refused.
select is((select status from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000a1', 'john')), 'accepted', 'John can switch variants before anything is sent');
select is((select status from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000a2'), 'rejected', 'the first choice is now rejected');
update public.gtm_outreach_drafts set linkedin_status = 'sent' where id = '00000000-0000-4000-8000-0000000000a1';
select throws_ok($$select * from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000a2', 'john')$$, '23514', null, 'no switching once a variant was acted on');
select throws_ok($$select * from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000ff', 'john')$$, 'P0002', null, 'an unknown draft is refused');

-- A regeneration (new version) keeps the old text and John's note.
update public.gtm_outreach_drafts set status = 'regenerate', note = 'Lead with their hiring post' where id = '00000000-0000-4000-8000-0000000000a3';
update public.gtm_outreach_drafts set body = 'B o v2', original_body = 'B o v2', version = 2, status = 'pending', note = '' where id = '00000000-0000-4000-8000-0000000000a3';
select results_eq($$select reason, version, body, status, note, actor from public.gtm_outreach_draft_versions where draft_id = '00000000-0000-4000-8000-0000000000a3'$$,
  $$values ('regenerated'::text, 1, 'B o'::text, 'regenerate'::text, 'Lead with their hiring post'::text, 'pipeline'::text)$$, 'a regeneration keeps the old text with John''s note');

select pg_temp.as_role('authenticated', true);
select is((select count(*)::int from public.gtm_outreach_drafts where batch = 'b-test'), 3, 'the owner reads drafts');
select throws_ok($$update public.gtm_outreach_drafts set status = 'accepted' where id = '00000000-0000-4000-8000-0000000000a3' returning id$$, '42501', null, 'the owner cannot write directly');
select throws_ok($$select * from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000a3', 'x')$$, '42501', null, 'the owner cannot call accept directly (the cockpit does, with the secret key)');

select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_outreach_drafts) + (select count(*)::int from public.gtm_outreach_draft_versions), 0, 'a non-owner reads nothing');

select pg_temp.as_role('anon', null);
select throws_ok($$select count(*) from public.gtm_outreach_drafts$$, '42501', null, 'anon has no access');

select * from finish();
rollback;
