-- Behaviour tests for 20261019000000_gtm_outreach_tracks.sql (one writing desk, two streams, VIB-463).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_outreach_tracks.sql   (also `supabase test db`)
-- Synthetic data only: .example domains and made-up names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);

-- The two tracks exist with their own sender and target; the client track carries the old desk's target.
select results_eq($$select track, daily_target, from_address from public.gtm_outreach_tracks order by track$$,
  $$values ('client'::text, 5, 'user-045d73df3c9a@example.com'::text), ('guest'::text, 2, 'user-8dd8662c2f5a@example.com'::text)$$, 'both tracks are seeded');
select is((select daily_target from public.gtm_outreach_tracks where track = 'client'), (select daily_target from public.gtm_outreach_desk), 'the client target carries over from the desk');
select throws_ok($$insert into public.gtm_outreach_tracks (track, daily_target, from_address) values ('other', 3, 'a@b.example')$$, '23514', null, 'only the two tracks');
select throws_ok($$update public.gtm_outreach_tracks set daily_target = 0 where track = 'guest'$$, '23514', null, 'the target is at least 1');
select throws_ok($$update public.gtm_outreach_tracks set from_address = 'not an address' where track = 'guest'$$, '23514', null, 'a sender is an email address');
update public.gtm_outreach_tracks set daily_target = 3, updated_by = 'john' where track = 'guest';
select is((select daily_target from public.gtm_outreach_tracks where track = 'guest'), 3, 'a track target can be edited');

-- Existing rows and new rows default to the client track; the guest track is explicit.
insert into public.gtm_outreach_dossiers (twenty_person_id, domain, name) values ('p-client', 'acme.example', 'Ada Example');
insert into public.gtm_outreach_dossiers (twenty_person_id, domain, name, track) values ('g-guest', 'ada-guest.guest.invalid', 'Grace Example', 'guest');
select results_eq($$select twenty_person_id, track from public.gtm_outreach_dossiers where twenty_person_id in ('p-client', 'g-guest') order by twenty_person_id$$,
  $$values ('g-guest'::text, 'guest'::text), ('p-client'::text, 'client'::text)$$, 'dossiers default to the client track');
select throws_ok($$insert into public.gtm_outreach_dossiers (twenty_person_id, track) values ('p-z', 'x')$$, '23514', null, 'a dossier track is client or guest');

-- A guest with no company domain is filed under a synthetic .guest.invalid key and gets a draft.
insert into public.gtm_outreach_drafts (id, batch, domain, variant, person, track, route, subject, body)
values ('00000000-0000-4000-8000-0000000000e1', 'desk', 'ada-guest.guest.invalid', 'john', 'g-guest', 'guest', 'linkedin', '', 'Hi Grace');
select is((select route from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000e1'), 'linkedin', 'a guest draft records its route');
select is((select track from public.gtm_outreach_drafts where batch = 'desk' and person = 'g-guest'), 'guest', 'a guest draft carries the guest track');
insert into public.gtm_outreach_drafts (id, batch, domain, variant, person, subject, body)
values ('00000000-0000-4000-8000-0000000000e2', 'desk', 'acme.example', 'john', 'p-client', 'S', 'B');
select results_eq($$select track, route from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000e2'$$,
  $$values ('client'::text, 'email'::text)$$, 'a desk draft defaults to client and email');
select throws_ok($$update public.gtm_outreach_drafts set route = 'fax' where id = '00000000-0000-4000-8000-0000000000e2'$$, '23514', null, 'a route is email, linkedin or intermediary');

-- Any route stamps its own sent time; the follow-up is stamped separately and never touches email_sent_at.
select is((select gtm_outreach_accept('00000000-0000-4000-8000-0000000000e1', 'john')::text is not null), true, 'a guest draft can be accepted');
update public.gtm_outreach_drafts set linkedin_status = 'sent' where id = '00000000-0000-4000-8000-0000000000e1';
select isnt((select linkedin_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000e1'), null, 'a LinkedIn route send is stamped');
update public.gtm_outreach_drafts set email_status = 'sent', follow_up_status = 'sent' where id = '00000000-0000-4000-8000-0000000000e1';
select isnt((select follow_up_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000e1'), null, 'marking the follow-up sent stamps it');
update public.gtm_outreach_drafts set follow_up_status = 'none' where id = '00000000-0000-4000-8000-0000000000e1';
select is((select follow_up_sent_at from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000e1'), null, 'undoing the follow-up clears its time');

select pg_temp.as_role('authenticated', true);
select is((select count(*)::int from public.gtm_outreach_tracks), 2, 'the owner reads both tracks');
select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_outreach_tracks), 0, 'a non-owner reads nothing');

select * from finish();
rollback;
