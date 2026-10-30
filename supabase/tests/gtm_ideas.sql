-- Behaviour tests for 20261013000000_gtm_ideas.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_ideas.sql   (also `supabase test db`)
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

select lives_ok($$insert into public.gtm_ideas (id, slug, title, summary, kind, status, tags)
  values ('00000000-0000-0000-0000-0000000000a1', 'simulator', 'AI Transformation Simulator', 'A micro-app.', 'lead_magnet', 'shortlisted', '{simulator,lead-magnet}')$$,
  'a lead-magnet idea is stored');
select is((select concat_ws(' ', status, kind, pillar is null, format is null) from public.gtm_ideas where slug = 'simulator'),
  'shortlisted lead_magnet t t', 'pillar and format are optional');
select lives_ok($$insert into public.gtm_ideas (slug, title) values ('bare', 'Just a title')$$,
  'a bare title is enough: kind content, status idea');
select is((select concat_ws(' ', kind, status, cardinality(tags)) from public.gtm_ideas where slug = 'bare'), 'content idea 0',
  'the defaults are content, idea and no tags');

select throws_ok($$insert into public.gtm_ideas (slug, title) values ('bare', 'Again')$$, '23505', null, 'one idea per slug');
select throws_ok($$insert into public.gtm_ideas (slug, title) values ('Not A Slug', 'T')$$, '23514', null, 'slugs are lowercase words and dashes');
select throws_ok($$insert into public.gtm_ideas (slug, title) values ('blank', '  ')$$, '23514', null, 'an idea has a title');
select throws_ok($$insert into public.gtm_ideas (slug, title, kind) values ('k', 'T', 'campaign')$$, '23514', null, 'only the five kinds');
select throws_ok($$insert into public.gtm_ideas (slug, title, pillar) values ('p', 'T', 'hype')$$, '23514', null, 'only the four pillars');
select throws_ok($$insert into public.gtm_ideas (slug, title, status) values ('s', 'T', 'done')$$, '23514', null, 'only the five statuses');
select throws_ok($$insert into public.gtm_ideas (slug, title, impact) values ('i', 'T', 6)$$, '23514', null, 'impact is 1 to 5');
select throws_ok($$insert into public.gtm_ideas (slug, title, effort) values ('e', 'T', 'xl')$$, '23514', null, 'effort is s, m or l');
select throws_ok($$insert into public.gtm_ideas (slug, title, source_url) values ('u', 'T', 'javascript:alert(1)')$$, '23514', null, 'a source is an http(s) link');

-- Promotion links the candidate; deleting the candidate keeps the idea and when it was promoted.
insert into public.gtm_content_candidates (id, week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('00000000-0000-0000-0000-0000000000b1', '2026-10-19', 'idea-bare', 'text', 'transformation', 'proof', '{linkedin}', 'T', 'B', '[{"url": "https://example.test"}]', '{}');
select throws_ok($$update public.gtm_ideas set promoted_candidate_id = '00000000-0000-0000-0000-0000000000b1' where slug = 'bare'$$,
  '23514', null, 'a promotion records when it happened');
update public.gtm_ideas set promoted_candidate_id = '00000000-0000-0000-0000-0000000000b1', promoted_at = now(), status = 'in_production' where slug = 'bare';
delete from public.gtm_content_candidates where id = '00000000-0000-0000-0000-0000000000b1';
select is((select concat_ws(' ', promoted_candidate_id is null, promoted_at is not null, status) from public.gtm_ideas where slug = 'bare'),
  't t in_production', 'deleting the candidate keeps the idea');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_ideas$$, '42501', null, 'anonymous cannot read ideas');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_ideas), 0::bigint, 'a signed-in non-owner reads no ideas');

select pg_temp.as_role('authenticated', true);
select is((select count(*) from public.gtm_ideas), 2::bigint, 'the owner reads every idea');
select throws_ok($$update public.gtm_ideas set status = 'parked'$$, '42501', null,
  'the owner changes ideas through the cockpit server, never directly');

select * from finish();
rollback;
