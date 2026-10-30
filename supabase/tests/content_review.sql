-- Behaviour tests for 20260928150000_content_review.sql. Run against a database that has the migration
-- applied (never prod):  psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/content_review.sql
-- Everything runs inside one transaction and is rolled back. Any failed expectation raises.
-- Also runs under `supabase test db` (CI `database` job). Every expectation is a TAP assertion
-- (ok / throws_ok with the expected SQLSTATE / lives_ok), counted by plan().
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);
-- Isolate existing local dogfood data; rollback restores it in full.
truncate public.review_comments, public.review_assets, public.review_batches;

create or replace function pg_temp.as_role(r text, owner boolean) returns void language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', case when owner is null then '' else json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000' || case when owner then '1' else '2' end,
    'role', r, 'app_metadata', json_build_object('gtm_owner', owner))::text end, true);
end $$;

-- service role (CLI) publishes round 1 with two assets
select pg_temp.as_role('service_role', null);
insert into public.review_batches (id, series, round, title, workspace_dir) values ('10000000-0000-0000-0000-000000000001', 'clips', 1, 'Round 1', '2-work/clips');
insert into public.review_assets (id, batch_id, position, slug, title, kind, storage_path) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 1, 'c1', 'Clip 1', 'video', 'clips/r1/1-c1.mp4'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 2, 'c2', 'Clip 2', 'video', 'clips/r1/2-c2.mp4');
select throws_ok($$insert into public.review_batches (series, round, title, workspace_dir) values ('other', 1, 'Other', 'x')$$,
  '23505', null, 'only one open batch at a time');

-- anon sees nothing
select pg_temp.as_role('anon', null);
select throws_ok($$select 1 from public.review_comments$$,
  '42501', null, 'anon cannot read comments');

-- signed-in non-owner sees nothing and cannot write
select pg_temp.as_role('authenticated', false);
select ok((select count(*) from public.review_batches) = 0, 'non-owner reads 0 batches');
select ok((select count(*) from public.review_assets) = 0, 'non-owner reads 0 assets');
select throws_ok($$insert into public.review_comments (batch_id, asset_id, t_ms, body)
  values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1000, 'x')$$,
  '42501', null, 'non-owner cannot comment');

-- owner comments; batch_id is derived from the asset, author/created_at are protected
select pg_temp.as_role('authenticated', true);
select ok((select count(*) from public.review_assets) = 2, 'owner reads 2 assets');
select lives_ok($lives$insert into public.review_comments (id, asset_id, t_ms, body) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 12500, 'Harp music is wrong'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', null, 'General note')$lives$, 'owner comments on an open batch');
select ok((select batch_id from public.review_comments where id = '30000000-0000-0000-0000-000000000001')
  = '10000000-0000-0000-0000-000000000001', 'comment batch_id derived from its asset');
select throws_ok($$insert into public.review_comments (batch_id, asset_id, body)
  values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'x')$$,
  '42501', null, 'owner cannot set batch_id directly (column not granted)');
select throws_ok($$insert into public.review_comments (asset_id, body) values ('20000000-0000-0000-0000-000000000001', '   ')$$,
  '23514', null, 'blank comment rejected');
select lives_ok($lives$update public.review_comments set body = 'Harp music is wrong, use future garage', t_ms = 12000
  where id = '30000000-0000-0000-0000-000000000001'$lives$, 'owner edits a comment');
select ok((select body from public.review_comments where id = '30000000-0000-0000-0000-000000000001')
  like '%future garage', 'owner edits a comment while open');
select lives_ok($lives$delete from public.review_comments where id = '30000000-0000-0000-0000-000000000002'$lives$, 'owner deletes a comment');
select ok((select count(*) from public.review_comments) = 1, 'owner deletes a comment while open');
select throws_ok($$update public.review_batches set title = 'hacked'$$,
  '42501', null, 'owner cannot rename a batch');
select throws_ok($$update public.review_batches set status = 'actioned'$$,
  '23514', null, 'owner cannot skip to actioned');
select throws_ok($$insert into public.review_comments (asset_id, t_ms, body)
  values ('20000000-0000-0000-0000-000000000001', -5, 'x')$$,
  '23514', null, 'negative timecode rejected');

-- owner submits; everything locks
select ok((select status from public.submit_review('10000000-0000-0000-0000-000000000001')) = 'submitted', 'submit_review moves open -> submitted');
select ok((select submitted_at is not null from public.review_batches
  where id = '10000000-0000-0000-0000-000000000001'), 'submitted_at stamped');
select throws_ok($$select public.submit_review('10000000-0000-0000-0000-000000000001')$$,
  '23514', null, 'submit_review on a non-open batch raises');
select throws_ok($$insert into public.review_comments (asset_id, body)
  values ('20000000-0000-0000-0000-000000000001', 'late')$$,
  '23514', null, 'no new comments after submit');
-- RLS filters locked rows out of the owner's UPDATE/DELETE (0 rows); the trigger backs it for other roles
create temp table _n (n int) on commit drop; grant all on _n to authenticated, service_role;
with u as (update public.review_comments set body = 'edit' returning 1) insert into _n select count(*) from u;
select ok((select n from _n) = 0, 'no edits after submit (0 rows changed)');
delete from _n;
with d as (delete from public.review_comments returning 1) insert into _n select count(*) from d;
select ok((select n from _n) = 0, 'no deletes after submit (0 rows removed)');
select ok((select body from public.review_comments where id = '30000000-0000-0000-0000-000000000001')
  like '%future garage', 'locked comment text unchanged');

-- TRUNCATE skips row triggers, so all application roles must lack it on every review table.
select pg_temp.as_role('service_role', null);
select throws_ok($$truncate public.review_comments$$,
  '42501', null, 'service role cannot truncate comments');
select throws_ok($$truncate public.review_batches cascade$$,
  '42501', null, 'service role cannot truncate batches');
select throws_ok($$truncate public.review_assets cascade$$,
  '42501', null, 'service role cannot truncate assets');
select ok(not has_table_privilege('authenticated', 'public.review_comments', 'TRUNCATE'), 'owner cannot truncate comments');

-- the lock also binds the service role; the next round can open
select pg_temp.as_role('service_role', null);
select throws_ok($$update public.review_comments set body = 'svc edit'$$,
  '23514', null, 'service role cannot edit a submitted batch');
select throws_ok($$update public.review_batches set status = 'open'
  where id = '10000000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a batch cannot reopen');
insert into public.review_batches (id, series, round, title, workspace_dir) values ('10000000-0000-0000-0000-000000000002', 'clips', 2, 'Round 2', '2-work/clips');
insert into public.review_assets (id, batch_id, position, slug, title, kind, storage_path) values
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 1, 'c1', 'Clip 1 v2', 'video', 'clips/r2/1-c1.mp4');
select throws_ok($$insert into public.review_comments (batch_id, asset_id, body)
  values ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'sneak into the open batch')$$,
  '23503', null, 'a comment whose batch_id does not match its asset raises (composite FK)');
select throws_ok($$select public.submit_review('10000000-0000-0000-0000-000000000002')$$,
  '42501', null, 'submit_review without the owner claim raises');
select ok((select count(*) from public.review_batches where status = 'open') = 1, 'next round opens after submit');
select lives_ok($lives$update public.review_batches set status = 'actioned' where id = '10000000-0000-0000-0000-000000000001'$lives$, 'service role actions a submitted round');
select ok((select actioned_at is not null from public.review_batches
  where id = '10000000-0000-0000-0000-000000000001'), 'service role marks a round actioned');

-- storage: owner can read bucket objects, non-owner cannot
insert into storage.objects (bucket_id, name) values ('content-review', 'clips/r1/1-c1.mp4');
select pg_temp.as_role('authenticated', true);
select ok((select count(*) from storage.objects where bucket_id = 'content-review' and name = 'clips/r1/1-c1.mp4') = 1, 'owner reads bucket object');
select pg_temp.as_role('authenticated', false);
select ok((select count(*) from storage.objects where bucket_id = 'content-review') = 0, 'non-owner reads 0 bucket objects');
select pg_temp.as_role('service_role', null);
select ok((select not public from storage.buckets where id = 'content-review'), 'bucket is private');
select ok((select 'application/pdf' = any(allowed_mime_types) from storage.buckets where id = 'content-review'), 'bucket accepts calendar PDFs');

-- Reservation and finalization are service-only; failed finalization is wholly rolled back.
select pg_temp.as_role('authenticated', true);
select throws_ok($$select public.reserve_review_publication(gen_random_uuid(), 'x', 1, 'x', 'x')$$,
  '42501', null, 'owner cannot reserve publication');
select lives_ok($lives$select public.submit_review('10000000-0000-0000-0000-000000000002')$lives$, 'owner submits round 2');
select pg_temp.as_role('service_role', null);
select lives_ok($lives$select public.reserve_review_publication('40000000-0000-0000-0000-000000000001', 'clips', 3, 'Round 3', '2-work/clips')$lives$, 'service role reserves round 3');
select throws_ok($$select public.reserve_review_publication(gen_random_uuid(), 'other', 1, 'x', 'x')$$,
  '23505', null, 'concurrent publisher refused');
select throws_ok($$select public.finalize_review_publication('40000000-0000-0000-0000-000000000001', '[{"position":1,"slug":"x","title":"x","kind":"invalid","storage_path":"x"}]')$$,
  '23514', null, 'invalid assets roll back publication');
select ok((select count(*) from public.review_batches where round = 3) = 0, 'failed publication leaves no batch');
select ok((select status from public.review_batches where round = 2) = 'submitted', 'failed publication does not action previous round');
select lives_ok($lives$select public.finalize_review_publication('40000000-0000-0000-0000-000000000001', '[{"position":1,"slug":"x","title":"x","kind":"image","storage_path":"40000000-0000-0000-0000-000000000001/a.jpg"}]')$lives$, 'service role finalizes round 3');
select ok((select status from public.review_batches where round = 2) = 'actioned', 'successful publication actions previous round');
select ok((select count(*) from public.review_assets where batch_id = '40000000-0000-0000-0000-000000000001') = 1, 'published batch includes assets');
select ok(not public.cancel_review_publication('40000000-0000-0000-0000-000000000001'), 'lost commit response must retain storage');
select pg_temp.as_role('authenticated', true);
select lives_ok($lives$select public.submit_review('40000000-0000-0000-0000-000000000001')$lives$, 'owner submits round 3');
select pg_temp.as_role('service_role', null);
select throws_ok($$select public.reserve_review_publication(gen_random_uuid(), 'clips', 3, 'x', 'x')$$,
  'P0001', null, 'republish submitted round refused before upload');
select lives_ok($lives$select public.reserve_review_publication('40000000-0000-0000-0000-000000000002', 'clips', 4, 'Round 4', '2-work/clips')$lives$, 'service role reserves round 4');
select ok(public.cancel_review_publication('40000000-0000-0000-0000-000000000002'), 'uncommitted publication can clean storage');
select throws_ok($$select public.finalize_review_publication('40000000-0000-0000-0000-000000000002', '[{}]')$$,
  'P0001', null, 'late finalization after cancellation rejected');
reset role;
select * from finish();
rollback;
