-- Structural security invariants for the public schema.
-- Each check is written as "the set of violations is empty", so a failure
-- names the offending objects. Run with `supabase test db`.

begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Every table in public has RLS on. Service role bypasses RLS, so a table
-- with RLS on and no policies is service-role only, which is the default we want.
select is_empty(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'every public table has row level security enabled'
);

-- Views run as the caller (lint 0010). Without security_invoker they
-- read the underlying tables as the view owner and bypass RLS (VIB-391).
-- Materialized views can't be security_invoker and there are none; add a
-- separate rule (no anon/authenticated grants) if one is ever introduced.
select is_empty(
  $$ select c.relname::text
       from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind = 'v'
        and not exists (
          select 1 from unnest(coalesce(c.reloptions, '{}')) o
           where lower(o) in ('security_invoker=on', 'security_invoker=true',
                              'security_invoker=yes', 'security_invoker=1')) $$,
  'every public view is security_invoker'
);

-- Functions we own (not ones installed by extensions) pin search_path (lint 0011).
select is_empty(
  $$ select p.proname::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%') $$,
  'every public function pins search_path'
);

-- The Story decision, stage decision, feedback and hold RPCs, the Season editor and the Storyboard Studio RPCs are the only
-- reviewed SECURITY DEFINER exceptions.
-- Each checks the signed-in owner claim and pins search_path in its migration. The review-link functions
-- (gtm_reviewer_*) check the caller's claimed, unrevoked invite instead, and the piece's third party and final stage.
select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.prosecdef
        -- Reviewed delivery state machine, append-only decision evidence and canonical reviewer.
        and p.oid <> 'public.gtm_replan_unsent_delivery(uuid,date,time,text)'::regprocedure
        and p.oid <> 'public.gtm_claim_legacy_send(text,jsonb)'::regprocedure
        and p.oid <> 'public.gtm_piece_record_decision_event()'::regprocedure
        and p.oid <> 'public.gtm_prepare_piece_deliveries(text,jsonb,jsonb,text)'::regprocedure
        and p.oid <> 'public.gtm_prepare_piece_delivery(text,text,date,time,text,jsonb,text)'::regprocedure
        and p.oid <> 'public.gtm_claim_piece_delivery(uuid,boolean)'::regprocedure
        and p.oid <> 'public.gtm_start_piece_send(uuid,uuid,jsonb)'::regprocedure
        and p.oid <> 'public.gtm_record_piece_delivery(uuid,uuid,text,text,text,text,timestamp with time zone)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_decide_piece_video(text,text,text,text,bigint,text)'::regprocedure
        and p.oid <> 'public.gtm_release_piece_delivery(uuid)'::regprocedure
        and p.oid <> 'public.gtm_resend_uncertain_delivery(uuid,uuid)'::regprocedure
        and p.oid <> 'public.gtm_resolve_uncertain_delivery(uuid,text)'::regprocedure
        and p.oid <> 'public.gtm_retire_piece_delivery(uuid,text)'::regprocedure
        and p.oid <> 'public.gtm_piece_record_release()'::regprocedure
        -- Shared review RPCs: scoped owner decisions; checked service staging/fix completion.
        and p.oid <> 'public.gtm_piece_asset_changed()'::regprocedure
        and p.oid <> 'public.gtm_piece_snapshot(text)'::regprocedure
        and p.oid <> 'public.gtm_piece_candidates(text)'::regprocedure
        and p.oid <> 'public.gtm_configure_piece_review(text,text,text,text[],jsonb)'::regprocedure
        and p.oid <> 'public.gtm_decide_piece_part(text,text,text,text,text,bigint)'::regprocedure
        and p.oid <> 'public.gtm_complete_piece_fix(uuid,text,bigint,text,text,boolean)'::regprocedure
        and p.oid <> 'public.gtm_save_piece_text(text,text,text,bigint)'::regprocedure
        and p.oid <> 'public.gtm_convert_piece_legacy_fix(text,uuid,text,text,bigint)'::regprocedure
        and p.oid <> 'public.gtm_piece_stage_reopened()'::regprocedure
        and p.oid <> 'public.gtm_set_piece_dispatch(text,jsonb,boolean)'::regprocedure
        and p.oid <> 'public.gtm_release_piece_review(text)'::regprocedure
        and p.oid <> 'public.gtm_decide_story_asset(text,text,text,text,text,bigint)'::regprocedure
        and p.oid <> 'public.gtm_add_story_feedback(text,text,text,uuid)'::regprocedure
        and p.oid <> 'public.gtm_update_season(text,text,text,date,date,text[])'::regprocedure
        and p.oid <> 'public.gtm_set_story_hold(text,boolean,text,text)'::regprocedure
        and p.oid <> 'public.gtm_decide_story_stage(text,text,text,text,jsonb,text[])'::regprocedure
        and p.oid <> 'public.gtm_add_storyboard_comment(text,integer,jsonb,text,text,jsonb,text,text,text)'::regprocedure
        and p.oid <> 'public.gtm_withdraw_storyboard_comment(uuid)'::regprocedure
        and p.oid <> 'public.gtm_decide_storyboard_scene(text,integer,text,text,text,text)'::regprocedure
        and p.oid <> 'public.gtm_decide_storyboard(text,integer,text,text,text,boolean,boolean)'::regprocedure
        and p.oid <> 'public.gtm_reopen_storyboard(text,text,text[])'::regprocedure
        and p.oid <> 'public.gtm_update_storyboard_rule(uuid,text,text,text)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_parties()'::regprocedure
        and p.oid <> 'public.gtm_reviewer_claim(text,text)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_story(text)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_throttle(text)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_add_feedback(text,text)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_decide(text,text,text,jsonb)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_decide_asset(text,text,text,text,integer)'::regprocedure
        and p.oid <> 'public.gtm_reviewer_decide_asset_by_link(text,text,text,text,text,integer)'::regprocedure
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') $$,
  'no unreviewed SECURITY DEFINER functions in public'
);

-- Nothing grants rows to anon (or to PUBLIC, which includes anon).
select is_empty(
  $$ select tablename || '.' || policyname
       from pg_policies
      where schemaname = 'public'
        and roles && array['anon', 'public']::name[] $$,
  'no RLS policy applies to anon or PUBLIC'
);

-- Every policy for signed-in users is gated on the server-set
-- app_metadata.gtm_owner claim, in USING and in WITH CHECK. user_metadata is
-- user-editable and never counts. A policy with another gate is a deliberate
-- decision; widen this check when one is made.
select is_empty(
  $$ select tablename || '.' || policyname
       from pg_policies
      where schemaname = 'public'
        and 'authenticated' = any(roles)
        and not (
          (qual is null or qual ~ $re$'app_metadata'::text\) ->> 'gtm_owner'$re$)
          and (with_check is null or with_check ~ $re$'app_metadata'::text\) ->> 'gtm_owner'$re$)
          and coalesce(qual, '') !~ 'user_metadata'
          and coalesce(with_check, '') !~ 'user_metadata') $$,
  'every authenticated policy requires app_metadata.gtm_owner'
);

-- Those owner-read policies are read-only.
select is_empty(
  $$ select tablename || '.' || policyname || ' ' || cmd
       from pg_policies
      where schemaname = 'public'
        and tablename like 'gtm\_%'
        and cmd <> 'SELECT' $$,
  'gtm_* policies are SELECT-only'
);

-- No user trigger in public is ENABLE ALWAYS ('A') or ENABLE REPLICA ('R').
-- 02_data_api_access.test.sql sets session_replication_role = replica precisely
-- so ordinary (ENABLE ORIGIN) triggers stay silent while it probes RLS with raw
-- writes; a trigger in either of these modes would keep firing (or only fire)
-- during that probe and escape the replica-mode quiet period.
select is_empty(
  $$ select tgrelid::regclass || '.' || tgname
       from pg_trigger
      where not tgisinternal
        and tgrelid::regclass::text !~ '^(storage|realtime|auth)\.'
        and tgenabled in ('A', 'R') $$,
  'no user trigger in public is ENABLE ALWAYS or ENABLE REPLICA'
);

select * from finish();
rollback;
