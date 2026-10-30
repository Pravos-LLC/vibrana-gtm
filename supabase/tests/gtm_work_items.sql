-- Behaviour tests for 20261013230000_gtm_work_items.sql (the cockpit's work board).
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_work_items.sql   (also `supabase test db`)
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

-- A piece with three John notes in /content (two old enough to count, one fresh), an agent note, and a /studio
-- storyboard with one open John comment and one the agent already answered.
select pg_temp.as_role('service_role', null);
insert into public.gtm_stories (id, title, link_url) values ('wi-story', 'Work Story', 'https://example.com/w');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, body) values
  ('wi-copy', 'wi-story', 'Copy', 'copy', 'copy.md', repeat('a', 64), 'Text');
insert into public.gtm_story_feedback (id, asset_id, channel, body, created_at, author) values
  ('00000000-0000-0000-0000-0000000000a1', 'wi-copy', 'linkedin', 'Tighten the hook', now() - interval '20 minutes', 'john'),
  ('00000000-0000-0000-0000-0000000000a2', 'wi-copy', 'linkedin', 'Shorter close', now() - interval '10 minutes', 'john'),
  ('00000000-0000-0000-0000-0000000000a3', 'wi-copy', 'linkedin', 'Just typed', now() - interval '1 minute', 'john'),
  ('00000000-0000-0000-0000-0000000000a4', 'wi-copy', 'linkedin', 'lint says', now() - interval '30 minutes', 'agent'),
  ('00000000-0000-0000-0000-0000000000a5', 'wi-copy', 'linkedin', 'From example_approver', now() - interval '30 minutes', 'third_party:example_approver');
insert into public.gtm_story_stages (story_id, stage, status) values ('wi-story', 'enhance-plan', 'review');
insert into public.gtm_storyboards (id, story_id, stage, format, title, current_version, status) values
  ('wi-board', 'wi-story', 'enhance-plan', 'short', 'Plan', 1, 'review');
insert into public.gtm_storyboard_versions (storyboard_id, version, doc, doc_sha, schema, scene_shas, produced_by) values
  ('wi-board', 1, '{"schema":"vibrana.storyboard/1"}', repeat('d', 64), 'vibrana.storyboard/1', '{}', 'test');
insert into public.gtm_storyboard_comments (id, storyboard_id, version, kind, body, author, status, created_at) values
  ('00000000-0000-0000-0000-0000000000b1', 'wi-board', 1, 'note', 'Swap the sheep', 'john', 'open', now() - interval '15 minutes'),
  ('00000000-0000-0000-0000-0000000000b2', 'wi-board', 1, 'note', 'Answered', 'john', 'addressed', now() - interval '15 minutes');

create temp view wi_waiting with (security_invoker = true) as
  select note_id from public.gtm_work_waiting_notes() where story_id = 'wi-story';
grant select on wi_waiting to authenticated, service_role;

select set_eq($$select note_id from wi_waiting$$,
  $$values ('00000000-0000-0000-0000-0000000000a1'::uuid), ('00000000-0000-0000-0000-0000000000a2'::uuid),
           ('00000000-0000-0000-0000-0000000000a5'::uuid), ('00000000-0000-0000-0000-0000000000b1'::uuid)$$,
  'waiting: John''s and the third party''s open notes older than five minutes, in /content and /studio; not agent notes, not fresh ones, not answered ones');

-- An agent picks up two of them.
insert into public.gtm_work_items (id, story_id, source_note_ids, title, agent) values
  ('00000000-0000-0000-0000-0000000000c1', 'wi-story',
   array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1']::uuid[], 'Work Story: 2 notes', 'content-engine');
select set_eq($$select note_id from wi_waiting$$,
  $$values ('00000000-0000-0000-0000-0000000000a2'::uuid), ('00000000-0000-0000-0000-0000000000a5'::uuid)$$,
  'a note a work item covers is no longer waiting');
select is((select status from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'), 'queued', 'a new item is queued');

-- Status timestamps follow the status.
update public.gtm_work_items set status = 'working', eta_at = now() + interval '30 minutes', last_update = 'Recutting the hook'
  where id = '00000000-0000-0000-0000-0000000000c1';
select ok((select staged_at is null and done_at is null and eta_at is not null from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'),
  'working: no staged or done time, the ETA kept');
update public.gtm_work_items set status = 'staged' where id = '00000000-0000-0000-0000-0000000000c1';
select ok((select staged_at is not null from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'), 'staged sets staged_at');
update public.gtm_work_items set status = 'done' where id = '00000000-0000-0000-0000-0000000000c1';
select ok((select done_at is not null and eta_at is null and staged_at is not null from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'),
  'done sets done_at, clears the ETA, keeps staged_at');
update public.gtm_work_items set status = 'working' where id = '00000000-0000-0000-0000-0000000000c1';
select ok((select done_at is null from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'), 'reopening clears done_at');

select throws_ok($$update public.gtm_work_items set status = 'blocked' where id = '00000000-0000-0000-0000-0000000000c1'$$,
  '23514', null, 'blocked needs a reason');
update public.gtm_work_items set status = 'blocked', blocked_reason = 'Needs the raw track' where id = '00000000-0000-0000-0000-0000000000c1';
select is((select blocked_reason from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'), 'Needs the raw track', 'blocked keeps its reason');
update public.gtm_work_items set status = 'working' where id = '00000000-0000-0000-0000-0000000000c1';
select is((select blocked_reason from public.gtm_work_items where id = '00000000-0000-0000-0000-0000000000c1'), '', 'leaving blocked clears the reason');

select throws_ok($$insert into public.gtm_work_items (title, status) values ('x', 'thinking')$$, '23514', null, 'an unknown status is refused');
select throws_ok($$insert into public.gtm_work_items (title) values ('   ')$$, '23514', null, 'a blank title is refused');
select lives_ok($$insert into public.gtm_work_items (title, status) values ('Done on arrival', 'done')$$, 'an item can be inserted done');
select ok((select done_at is not null from public.gtm_work_items where title = 'Done on arrival'), 'inserted done gets done_at');

-- The story going away keeps the job's history.
insert into public.gtm_stories (id, title, link_url) values ('wi-gone', 'Gone', 'https://example.com/g');
insert into public.gtm_work_items (story_id, title) values ('wi-gone', 'Gone: 1 note');
delete from public.gtm_stories where id = 'wi-gone';
select ok((select story_id is null from public.gtm_work_items where title = 'Gone: 1 note'), 'deleting the story keeps the item, unlinked');

-- RLS: the owner reads; nobody else does; nobody but the service role writes.
select pg_temp.as_role('anon', null);
select throws_ok($$select * from public.gtm_work_items$$, '42501', null, 'anonymous cannot read work items');
select throws_ok($$select * from public.gtm_work_waiting_notes()$$, '42501', null, 'anonymous cannot list waiting notes');

select pg_temp.as_role('authenticated', false);
select is((select count(*)::int from public.gtm_work_items), 0, 'a non-owner reads no work items');
select is((select count(*)::int from wi_waiting), 0, 'a non-owner sees no waiting notes (security invoker, RLS applies)');

select pg_temp.as_role('authenticated', true);
select ok((select count(*) from public.gtm_work_items where story_id = 'wi-story') = 1, 'the owner reads work items');
select set_eq($$select note_id from wi_waiting$$,
  $$values ('00000000-0000-0000-0000-0000000000a2'::uuid), ('00000000-0000-0000-0000-0000000000a5'::uuid)$$,
  'the owner sees the waiting notes');
select throws_ok($$update public.gtm_work_items set status = 'done'$$, '42501', null, 'the owner cannot write work items from the browser');

select * from finish();
rollback;
