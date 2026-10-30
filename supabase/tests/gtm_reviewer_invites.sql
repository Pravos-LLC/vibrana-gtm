-- Behaviour tests for 20261013120000_gtm_reviewer_invites.sql.
-- psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gtm_reviewer_invites.sql   (also `supabase test db`)
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

-- uid suffix: 1 = owner, 3 = example_approver, 4 = someone else holding a forwarded link. meta: the app_metadata object.
create or replace function pg_temp.as_user(n int, meta jsonb) returns void language plpgsql as $$
begin
  if n is null then
    set local role anon;
    perform set_config('request.jwt.claims', '', true);
    return;
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || n, 'role', 'authenticated', 'app_metadata', meta)::text, true);
end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '', true);
end $$;

select pg_temp.as_service();
insert into public.gtm_stories (id, title, link_url, pipeline, third_party_who, held_at, hold_who) values
  ('rv-example_approver', 'example_approver short', 'https://example.com/a', 'short', 'example_approver / Example Series', now(), 'example_approver / Example Series'),
  ('rv-other', 'Other short', 'https://example.com/b', 'short', null, null, null),
  ('rv-rough', 'example_approver rough', 'https://example.com/c', 'short', 'example_approver / Example Series', null, null);
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage) values
  ('rv-example_approver-v', 'rv-example_approver', 'Video', 'video', 'v.mp4', repeat('a', 64), 'stories/rv-example_approver/v.mp4', 'final'),
  ('rv-other-v', 'rv-other', 'Video', 'video', 'v.mp4', repeat('b', 64), 'stories/rv-other/v.mp4', 'final'),
  ('rv-rough-v', 'rv-rough', 'Video', 'video', 'v.mp4', repeat('c', 64), 'stories/rv-rough/v.mp4', 'rough-cut');
insert into public.gtm_story_asset_channels (asset_id, channel) values
  ('rv-example_approver-v', 'instagram'), ('rv-example_approver-v', 'youtube'), ('rv-other-v', 'youtube'), ('rv-rough-v', 'youtube');
insert into public.gtm_reviewer_invites (token_sha256, party, expires_at) values
  (repeat('1', 64), 'example_approver / Example Series', now() + interval '14 days'),
  (repeat('2', 64), 'example_approver / Example Series', now() - interval '1 minute');

-- The browser role never touches the invite table directly.
select pg_temp.as_user(3, '{}');
select is_empty($$select 1 from public.gtm_reviewer_invites$$, 'a non-owner reads no invites');
select throws_ok($$insert into public.gtm_reviewer_invites (token_sha256, party, expires_at) values (repeat('9', 64), 'x', now() + interval '1 day')$$,
  '42501', null, 'a non-owner cannot create an invite');
select is(public.gtm_reviewer_parties(), '{}'::text[], 'nobody reviews anything before claiming');

select pg_temp.as_user(null, null);
select throws_ok($$select public.gtm_reviewer_claim(repeat('1', 64), 'x@example.com')$$, '42501', null, 'anonymous cannot claim');

select pg_temp.as_user(1, '{"gtm_owner": true}');
select throws_ok($$select public.gtm_reviewer_claim(repeat('1', 64), 'john@example.com')$$, '42501', null, 'the owner never uses up a link');
select pg_temp.as_user(1, '{"gtm_team": true}');
select throws_ok($$select public.gtm_reviewer_claim(repeat('1', 64), 'abe@example.com')$$, '42501', null, 'a team member never uses up a link');

select pg_temp.as_user(3, '{}');
select throws_ok($$select public.gtm_reviewer_claim(repeat('2', 64), 'example_approver@example.com')$$, '22023', 'this review link is not valid', 'an expired link is refused');
select throws_ok($$select public.gtm_reviewer_claim(repeat('7', 64), 'example_approver@example.com')$$, '22023', 'this review link is not valid', 'an unknown link is refused the same way');
select is(public.gtm_reviewer_claim(repeat('1', 64), ' example_approver@Example.com '), 'example_approver / Example Series', 'the first person to open the link claims it');
select is(public.gtm_reviewer_claim(repeat('1', 64), 'example_approver@example.com'), 'example_approver / Example Series', 'claiming your own link again is a no-op');
select is(public.gtm_reviewer_parties(), '{"example_approver / Example Series"}'::text[], 'the claimer reviews for the party');

-- A link makes up to two logins (example_approver and his cofounder); a third is refused.
select pg_temp.as_user(4, '{}');
select is(public.gtm_reviewer_claim(repeat('1', 64), 'kelsey@example.com'), 'example_approver / Example Series', 'a second login can use the same link');
select is(public.gtm_reviewer_parties(), '{"example_approver / Example Series"}'::text[], 'the second login reviews for the party too');
select pg_temp.as_user(5, '{}');
select throws_ok($$select public.gtm_reviewer_claim(repeat('1', 64), 'someone@example.com')$$, '22023', 'this review link is not valid', 'a third login is refused');
select throws_ok($$select public.gtm_reviewer_add_feedback('rv-example_approver-v', 'hi')$$, '42501', null, 'someone without an invite cannot comment');

-- Scope: example_approver's pieces only, finals only.
select pg_temp.as_user(3, '{}');
select throws_ok($$select public.gtm_reviewer_add_feedback('rv-other-v', 'hi')$$, '42501', 'not found', 'another piece is invisible');
select throws_ok($$select public.gtm_reviewer_add_feedback('rv-rough-v', 'hi')$$, '22023', null, 'a rough cut is not shared');
select throws_ok($$select public.gtm_reviewer_decide('rv-other', 'approved', '', '[{"asset_id":"rv-other-v","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","revision":1}]')$$,
  '42501', null, 'another piece cannot be approved');
select throws_ok($$select public.gtm_set_story_hold('rv-example_approver', false, null, null)$$, '42501', null, 'the owner-only release stays owner-only');
select throws_ok($$select public.gtm_add_story_feedback('rv-example_approver-v', null, 'x')$$, '42501', null, 'the owner-only note stays owner-only');

select lives_ok($$select public.gtm_reviewer_add_feedback('rv-example_approver-v', '  Love it, maybe a longer end card  ')$$, 'example_approver leaves a note on his final');
select throws_ok($$select public.gtm_reviewer_decide('rv-example_approver', 'changes', ' ', '[{"asset_id":"rv-example_approver-v","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  '22023', null, 'changes need a note');
select throws_ok($$select public.gtm_reviewer_decide('rv-example_approver', 'approved', '', '[{"asset_id":"rv-example_approver-v","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","revision":1}]')$$,
  'PT409', null, 'stale bytes are refused');
select lives_ok($$select public.gtm_reviewer_decide('rv-example_approver', 'changes', 'Please spell Mamos right', '[{"asset_id":"rv-example_approver-v","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  'example_approver requests changes');
select lives_ok($$select public.gtm_reviewer_decide('rv-example_approver', 'approved', 'Good to go', '[{"asset_id":"rv-example_approver-v","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  'example_approver approves the final');

select pg_temp.as_service();
select results_eq($$select body, author, stage from public.gtm_story_feedback where asset_id = 'rv-example_approver-v' order by created_at, body$$,
  $$values ('Love it, maybe a longer end card'::text, 'third_party:example_approver / Example Series'::text, 'final'::text), ('Please spell Mamos right', 'third_party:example_approver / Example Series', 'final')$$,
  'his notes are signed as the third party, at the final');
select results_eq($$select party, who, decision, assets, decided_by from public.gtm_story_stage_decisions where story_id = 'rv-example_approver' order by decided_at, decision desc$$,
  $$values ('third_party'::text, 'example_approver / Example Series'::text, 'changes'::text, '[{"asset_id":"rv-example_approver-v","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]'::jsonb, '00000000-0000-0000-0000-000000000003'::uuid),
           ('third_party', 'example_approver / Example Series', 'approved', '[{"asset_id":"rv-example_approver-v","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]'::jsonb, '00000000-0000-0000-0000-000000000003'::uuid)$$,
  'both decisions are logged against the final''s bytes, by example_approver');
select results_eq($$select held_at is null from public.gtm_stories where id = 'rv-example_approver'$$, $$values (true)$$, 'his approval releases the hold');

-- A hold John set for another reason survives their approval.
update public.gtm_stories set held_at = now(), hold_who = 'Legal', hold_note = 'waiting on legal' where id = 'rv-example_approver';
select pg_temp.as_user(3, '{}');
select lives_ok($$select public.gtm_reviewer_decide('rv-example_approver', 'approved', '', '[{"asset_id":"rv-example_approver-v","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}]')$$,
  'example_approver approves again');
select pg_temp.as_service();
select results_eq($$select hold_who from public.gtm_stories where id = 'rv-example_approver'$$, $$values ('Legal'::text)$$, 'someone else''s hold stays');

-- Per-asset decisions: approve, request changes or note on each asset; the Story's sign-off follows the approval of every video and image (a listing's copy never holds it back).
select pg_temp.as_service();
insert into public.gtm_stories (id, title, link_url, pipeline, third_party_who, held_at, hold_who) values
  ('rv-new', 'example_approver episode', 'https://example.com/d', 'episode', 'example_approver / Example Series', now(), 'example_approver / Example Series');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage, body) values
  ('rv-new-v', 'rv-new', 'Episode', 'video', 'v.mp4', repeat('e', 64), 'stories/rv-new/v.mp4', 'final', null),
  ('rv-new-c', 'rv-new', 'YouTube listing', 'copy', 'c.md', repeat('f', 64), null, null, 'Title and description');
insert into public.gtm_story_asset_channels (asset_id, channel) values ('rv-new-v', 'youtube'), ('rv-new-c', 'youtube');
select pg_temp.as_user(3, '{}');
select throws_ok($$select public.gtm_reviewer_decide_asset('rv-other-v', 'approved', '', repeat('b', 64), 1)$$, '42501', null, 'another piece''s asset cannot be decided');
select throws_ok($$select public.gtm_reviewer_decide_asset('rv-new-c', 'changes', ' ', repeat('f', 64), 1)$$, '22023', null, 'changes need a note');
select throws_ok($$select public.gtm_reviewer_decide_asset('rv-new-v', 'approved', '', repeat('d', 64), 1)$$, 'PT409', null, 'stale bytes are refused per asset');
select lives_ok($$select public.gtm_reviewer_decide_asset('rv-new-v', 'approved', '', repeat('e', 64), 1)$$, 'example_approver approves the video');
select pg_temp.as_service();
select results_eq($$select held_at is not null from public.gtm_stories where id = 'rv-new'$$, $$values (false)$$, 'approving the video, the only media, releases the hold even with the listing undecided');
select pg_temp.as_user(3, '{}');
select lives_ok($$select public.gtm_reviewer_decide_asset('rv-new-c', 'note', 'Love the hook', repeat('f', 64), 1)$$, 'a note on the listing');
select lives_ok($$select public.gtm_reviewer_decide_asset('rv-new-c', 'changes', 'Change the title', repeat('f', 64), 1)$$, 'changes on the listing');
select pg_temp.as_service();
select results_eq($$select count(*)::int from public.gtm_story_stage_decisions where story_id = 'rv-new' and decision = 'changes'$$, $$values (1)$$, 'the request is visible to John as a stage decision');
select is_empty($$select 1 from public.gtm_story_feedback where asset_id in ('rv-new-v', 'rv-new-c')$$, 'a third party''s asset decisions never create agent work');
select pg_temp.as_user(4, '{}');
select lives_ok($$select public.gtm_reviewer_decide_asset('rv-new-c', 'approved', '', repeat('f', 64), 1)$$, 'the second login approves the listing');
select pg_temp.as_service();
select results_eq($$select held_at is null from public.gtm_stories where id = 'rv-new'$$, $$values (true)$$, 'the hold stays released after the listing is approved too');

-- No login: the link itself decides, through the service role only.
select pg_temp.as_service();
insert into public.gtm_stories (id, title, link_url, pipeline, third_party_who, held_at, hold_who) values
  ('rv-link', 'example_approver link short', 'https://example.com/l', 'short', 'example_approver / Example Series', now(), 'example_approver / Example Series');
insert into public.gtm_story_assets (id, story_id, title, kind, source, sha256, storage_path, stage) values
  ('rv-link-v', 'rv-link', 'Video', 'video', 'v.mp4', repeat('9', 64), 'stories/rv-link/v.mp4', 'final');
insert into public.gtm_story_asset_channels (asset_id, channel) values ('rv-link-v', 'youtube');
select throws_ok($$select public.gtm_reviewer_decide_asset_by_link(repeat('7', 64), 'rv-link-v', 'approved', '', repeat('9', 64), 1)$$, '42501', null, 'an unknown link decides nothing');
select throws_ok($$select public.gtm_reviewer_decide_asset_by_link(repeat('2', 64), 'rv-link-v', 'approved', '', repeat('9', 64), 1)$$, '42501', null, 'an expired link decides nothing');
select throws_ok($$select public.gtm_reviewer_decide_asset_by_link(repeat('1', 64), 'rv-other-v', 'approved', '', repeat('b', 64), 1)$$, '42501', null, 'a link cannot reach another party''s piece');
select lives_ok($$select public.gtm_reviewer_decide_asset_by_link(repeat('1', 64), 'rv-link-v', 'approved', '', repeat('9', 64), 1)$$, 'the link approves the video with no login');
select results_eq($$select held_at is null from public.gtm_stories where id = 'rv-link'$$, $$values (true)$$, 'and that releases the hold');
select pg_temp.as_user(3, '{}');
select throws_ok($$select public.gtm_reviewer_decide_asset_by_link(repeat('1', 64), 'rv-link-v', 'approved', '', repeat('9', 64), 1)$$, '42501', null, 'a browser session cannot call it');
select pg_temp.as_service();

-- An outside account is capped at 30 writes an hour.
insert into public.gtm_story_feedback (asset_id, body, author, created_at)
  select 'rv-example_approver-v', 'flood ' || g, 'third_party:example_approver / Example Series', now() from generate_series(1, 30) g;
select pg_temp.as_user(3, '{}');
select throws_ok($$select public.gtm_reviewer_add_feedback('rv-example_approver-v', 'one more')$$, 'P0429', null, 'the 31st write in an hour is refused');
select pg_temp.as_service();

-- Revoking cuts access at once.
update public.gtm_reviewer_invites set revoked_at = now() where token_sha256 = repeat('1', 64);
select pg_temp.as_user(3, '{}');
select throws_ok($$select public.gtm_reviewer_add_feedback('rv-example_approver-v', 'hi')$$, '42501', null, 'a revoked reviewer is shut out');
select pg_temp.as_user(4, '{}');
select throws_ok($$select public.gtm_reviewer_decide_asset('rv-new-v', 'approved', '', repeat('e', 64), 1)$$, '42501', null, 'the second login is shut out too');

select * from finish();
rollback;
