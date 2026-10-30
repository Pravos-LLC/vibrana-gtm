-- Behaviour tests for 20261017010000_gtm_outreach_desk.sql (the writing desk, /outreach/write).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_outreach_desk.sql   (also `supabase test db`)
-- Synthetic data only: .example domains and made-up names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);

-- Two people at one company each get their own desk draft; pipeline drafts (person '') stay one per company.
insert into public.gtm_outreach_drafts (id, batch, domain, variant, person, subject, body)
values
  ('00000000-0000-4000-8000-0000000000d1', 'desk', 'acme.example', 'john', 'p-ada', 'S ada', 'B ada'),
  ('00000000-0000-4000-8000-0000000000d2', 'desk', 'acme.example', 'john', 'p-bob', 'S bob', 'B bob');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, variant, person) values ('desk', 'acme.example', 'john', 'p-ada')$$, '23505', null, 'one desk draft per person');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, variant, person) values ('desk', 'acme.example', 'john', 'bad id')$$, '23514', null, 'a person id is a plain token');
insert into public.gtm_outreach_drafts (batch, domain, variant) values ('pipe', 'acme.example', 'main');
select throws_ok($$insert into public.gtm_outreach_drafts (batch, domain, variant) values ('pipe', 'acme.example', 'main')$$, '23505', null, 'pipeline drafts stay unique per (batch, domain, variant)');

-- Accepting one person's draft leaves the colleague's alone; both can be accepted.
select is((select status from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000d1', 'john')), 'accepted', 'accept one person');
select is((select status from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000d2'), 'pending', 'the colleague is not a sibling variant');
select is((select status from public.gtm_outreach_accept('00000000-0000-4000-8000-0000000000d2', 'john')), 'accepted', 'two people at one company can both be accepted');

-- Sent times are set once, by whoever marks the status.
update public.gtm_outreach_drafts set email_status = 'sent' where id = '00000000-0000-4000-8000-0000000000d1';
select isnt((select email_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000d1'), null, 'marking an email sent records when');
select is((select linkedin_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000d1'), null, 'the LinkedIn time stays empty');
update public.gtm_outreach_drafts set email_sent_at = '2026-01-01T00:00:00Z' where id = '00000000-0000-4000-8000-0000000000d1';
update public.gtm_outreach_drafts set email_status = 'replied' where id = '00000000-0000-4000-8000-0000000000d1';
select is((select email_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000d1'), '2026-01-01T00:00:00Z'::timestamptz, 'a reply keeps the first sent time');
update public.gtm_outreach_drafts set linkedin_status = 'connected' where id = '00000000-0000-4000-8000-0000000000d2';
select isnt((select linkedin_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000d2'), null, 'a connection counts as an invite sent');

-- Dossiers.
insert into public.gtm_outreach_dossiers (twenty_person_id, domain, name, company, score, dossier)
values ('p-ada', 'acme.example', 'Ada Example', 'Acme', 81.5, '{"prospect":{"first_name":"Ada"}}');
select throws_ok($$insert into public.gtm_outreach_dossiers (twenty_person_id, dossier) values ('p-x', '[]')$$, '23514', null, 'a dossier is an object');
select throws_ok($$insert into public.gtm_outreach_dossiers (twenty_person_id, domain) values ('p-y', 'Not A Domain')$$, '23514', null, 'a dossier domain is a hostname');
select throws_ok($$update public.gtm_outreach_dossiers set skip_reason = 'no' where twenty_person_id = 'p-ada'$$, '23514', null, 'a skip reason needs a skip');
update public.gtm_outreach_dossiers set skipped_at = now(), skip_reason = 'Former client', skipped_by = 'john' where twenty_person_id = 'p-ada';
insert into public.gtm_outreach_dossiers (twenty_person_id, domain, name, dossier) values ('p-ada', 'acme.example', 'Ada Example', '{"prospect":{"first_name":"Ada","title":"CEO"}}')
  on conflict (twenty_person_id) do update set name = excluded.name, dossier = excluded.dossier;
select results_eq($$select skip_reason, dossier #>> '{prospect,title}' from public.gtm_outreach_dossiers where twenty_person_id = 'p-ada'$$,
  $$values ('Former client'::text, 'CEO'::text)$$, 'a re-import refreshes the dossier and keeps the skip');

-- The desk: one row, a sane target.
select is((select daily_target from public.gtm_outreach_desk), 5, 'the daily target defaults to 5');
select throws_ok($$insert into public.gtm_outreach_desk (id) values (false)$$, '23514', null, 'there is only one desk');
select throws_ok($$update public.gtm_outreach_desk set daily_target = 0$$, '23514', null, 'the target is at least 1');

select pg_temp.as_role('authenticated', true);
select is((select count(*)::int from public.gtm_outreach_dossiers where twenty_person_id = 'p-ada') + (select count(*)::int from public.gtm_outreach_desk), 2, 'the owner reads dossiers and the desk');
select throws_ok($$update public.gtm_outreach_desk set daily_target = 9 returning id$$, '42501', null, 'the owner cannot write directly');

select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_outreach_dossiers) + (select count(*)::int from public.gtm_outreach_desk), 0, 'a non-owner reads nothing');

select pg_temp.as_role('anon', null);
select throws_ok($$select count(*) from public.gtm_outreach_dossiers$$, '42501', null, 'anon has no access');

select * from finish();
rollback;
