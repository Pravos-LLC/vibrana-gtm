-- Behaviour tests for 20261110010000_gtm_outreach_network_track.sql (a third writing-desk stream: John's own network, VIB-522).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_outreach_network_track.sql   (also `supabase test db`)
-- Synthetic data only: .example domains and made-up names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

select pg_temp.as_role('service_role', null);

-- The network row: its own target and sender, editable like any track, under the same checks.
select results_eq($$select daily_target, from_address from public.gtm_outreach_tracks where track = 'network'$$,
  $$values (15, 'user-f538cb95fc21@example.com'::text)$$, 'the network track is seeded with target 15 and its sender');
select throws_ok($$update public.gtm_outreach_tracks set daily_target = 0 where track = 'network'$$, '23514', null, 'the network target is at least 1');
update public.gtm_outreach_tracks set daily_target = 20, updated_by = 'john' where track = 'network';
select is((select daily_target from public.gtm_outreach_tracks where track = 'network'), 20, 'the network target can be edited');
select throws_ok($$insert into public.gtm_outreach_tracks (track, daily_target, from_address) values ('network', 3, 'a@b.example')$$, '23505', null, 'one network row');
select throws_ok($$insert into public.gtm_outreach_tracks (track, daily_target, from_address) values ('cold', 3, 'a@b.example')$$, '23514', null, 'an unknown track is still refused');

-- The seed is idempotent and never overwrites John's own settings.
insert into public.gtm_outreach_tracks (track, daily_target, from_address) values ('network', 15, 'user-f538cb95fc21@example.com') on conflict (track) do nothing;
select is((select daily_target from public.gtm_outreach_tracks where track = 'network'), 20, 'reseeding keeps the edited target');

-- A network dossier and its desk draft carry the network track; a LinkedIn note is a route like a guest's.
insert into public.gtm_outreach_dossiers (twenty_person_id, domain, name, track)
values ('00000000-0000-4000-8000-00000000a001', 'nia-example.network.invalid', 'Nia Example', 'network');
select is((select track from public.gtm_outreach_dossiers where twenty_person_id = '00000000-0000-4000-8000-00000000a001'), 'network', 'a dossier can be on the network track');
select throws_ok($$insert into public.gtm_outreach_dossiers (twenty_person_id, track) values ('p-n', 'networks')$$, '23514', null, 'a dossier track is still checked');
insert into public.gtm_outreach_drafts (id, batch, domain, variant, person, track, route, subject, body, linkedin_note)
values ('00000000-0000-4000-8000-0000000000f1', 'desk', 'nia-example.network.invalid', 'john', '00000000-0000-4000-8000-00000000a001', 'network', 'linkedin', '', '', 'Hi Nia');
select results_eq($$select track, route from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000f1'$$,
  $$values ('network'::text, 'linkedin'::text)$$, 'a network draft records its track and route');
select throws_ok($$update public.gtm_outreach_drafts set track = 'warm' where id = '00000000-0000-4000-8000-0000000000f1'$$, '23514', null, 'a draft track is still checked');

-- The LinkedIn note stamps its own sent time; the follow-up is stamped separately and never touches the first touch.
select is((select gtm_outreach_accept('00000000-0000-4000-8000-0000000000f1', 'john')::text is not null), true, 'a network draft can be accepted');
update public.gtm_outreach_drafts set linkedin_status = 'sent' where id = '00000000-0000-4000-8000-0000000000f1';
select results_eq($$select linkedin_sent_at is not null, email_sent_at is null from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000f1'$$,
  $$values (true, true)$$, 'a LinkedIn note on the network track is stamped as LinkedIn, not email');
update public.gtm_outreach_drafts set follow_up_status = 'sent' where id = '00000000-0000-4000-8000-0000000000f1';
select results_eq($$select follow_up_sent_at is not null, email_sent_at is null from public.gtm_outreach_drafts where id = '00000000-0000-4000-8000-0000000000f1'$$,
  $$values (true, true)$$, 'the network follow-up is stamped on its own');

-- The angle-learning runs accept the track too (the desk never records one for the network: it has no AI angles).
insert into public.gtm_outreach_angle_runs (person, track, angles) values ('00000000-0000-4000-8000-00000000a001', 'network', '[]');
select is((select track from public.gtm_outreach_angle_runs where person = '00000000-0000-4000-8000-00000000a001'), 'network', 'an angle run can name the network track');

select pg_temp.as_role('authenticated', true);
select is((select daily_target from public.gtm_outreach_tracks where track = 'network'), 20, 'the owner reads the network track');
select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_outreach_tracks where track = 'network'), 0, 'a non-owner reads nothing');

select * from finish();
rollback;
