-- Behaviour tests for 20261011160000_gtm_content_candidates.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_content_candidates.sql   (also `supabase test db`)
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

insert into public.gtm_signal_stories (id, title) values ('00000000-0000-0000-0000-0000000000c1', 'A signal');

select lives_ok($$insert into public.gtm_content_candidates
  (id, week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft, signal_id)
  values ('00000000-0000-0000-0000-0000000000d1', '2026-10-12', 'a-text-post', 'text', 'regenerative', 'perspective',
          '{linkedin}', 'A text post', 'Body', '[{"url": "https://example.test/a"}]', '{"body": "Body"}',
          '00000000-0000-0000-0000-0000000000c1')$$,
  'a text candidate is stored');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-12', 'a-text-post', 'text', 'regenerative', 'perspective', '{linkedin}', 'T', 'B', '[{}]', '{}')$$,
  '23505', null, 'one candidate per week and slug');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-13', 'tuesday', 'text', 'regenerative', 'perspective', '{linkedin}', 'T', 'B', '[{}]', '{}')$$,
  '23514', null, 'the week starts on a Monday');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-12', 'deck', 'carousel', 'thought_leadership', 'lists', '{linkedin}', 'T', 'B', '[{}]', '{}')$$,
  '23514', null, 'a carousel carries its slides');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-12', 'clip', 'video', 'regenerative', 'perspective', '{linkedin}', 'T', 'B', '[{}]', '{}')$$,
  '23514', null, 'a video carries its script');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-12', 'nosrc', 'text', 'regenerative', 'perspective', '{linkedin}', 'T', 'B', '[]', '{}')$$,
  '23514', null, 'a candidate names at least one source');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-12', 'tiktok', 'text', 'regenerative', 'perspective', '{tiktok}', 'T', 'B', '[{}]', '{}')$$,
  '23514', null, 'only LinkedIn, Instagram and YouTube');
select throws_ok($$insert into public.gtm_content_candidates (week_start, slug, format, lens, pillar, channels, title, body, sources, agent_draft)
  values ('2026-10-12', 'lens', 'text', 'growth', 'perspective', '{linkedin}', 'T', 'B', '[{}]', '{}')$$,
  '23514', null, 'only the three lenses');

select throws_ok($$update public.gtm_content_candidates set status = 'rejected', decided_at = now() where slug = 'a-text-post'$$,
  '23514', null, 'a rejection records its reason');
select throws_ok($$update public.gtm_content_candidates set status = 'accepted' where slug = 'a-text-post'$$,
  '23514', null, 'a decision records when it was made');
select lives_ok($$update public.gtm_content_candidates set status = 'rejected', decided_at = now(), reject_reason = 'angle' where slug = 'a-text-post'$$,
  'a candidate is rejected with a reason');

-- The signal remembers why: a reject is a taste label with its reason and candidate.
select throws_ok($$insert into public.gtm_signal_feedback (story_id, actor, action) values ('00000000-0000-0000-0000-0000000000c1', 'john', 'reject')$$,
  '23514', null, 'a reject label needs a reason');
select lives_ok($$insert into public.gtm_signal_feedback (story_id, actor, action, reason, candidate_id)
  values ('00000000-0000-0000-0000-0000000000c1', 'john', 'reject', 'angle', '00000000-0000-0000-0000-0000000000d1')$$,
  'a reject label carries its reason and candidate');

select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_content_candidates$$, '42501', null, 'anonymous cannot read candidates');

select pg_temp.as_role('authenticated', false);
select is((select count(*) from public.gtm_content_candidates), 0::bigint, 'a signed-in non-owner reads no candidates');

select pg_temp.as_role('authenticated', true);
select throws_ok($$update public.gtm_content_candidates set title = 'x'$$, '42501', null,
  'the owner edits candidates through the cockpit server, never directly');

select * from finish();
rollback;
