-- Retire shared review (John, 2026-11-02: one simpler content system). Phase 2 of the content audit kept the
-- per-file approvals (gtm_story_asset_channels) as what binds a piece's channels and the bytes John approved, so the
-- shared-piece review and its delivery ledger (20261017020000, 20261017030000) never carried a piece. This drops their
-- six tables, their functions and the triggers they put on the content tables, and keeps the one surviving sender's
-- claim (gtm_claim_legacy_send) with its shared-piece checks removed. The tables were empty in production when this
-- was written; the guard below refuses to drop any row.
begin;

do $$
begin
  if exists(select 1 from public.gtm_piece_reviews) or exists(select 1 from public.gtm_piece_part_decisions)
  or exists(select 1 from public.gtm_piece_fixes) or exists(select 1 from public.gtm_piece_deliveries)
  or exists(select 1 from public.gtm_piece_delivery_attempts) or exists(select 1 from public.gtm_piece_decision_events) then
    raise exception 'shared review still holds rows; retire them explicitly before dropping its tables';
  end if;
end $$;

-- Triggers shared review put on tables that stay.
drop trigger gtm_piece_asset_changed on public.gtm_story_assets;
drop trigger gtm_piece_asset_identity_guard on public.gtm_story_assets;
drop trigger gtm_piece_asset_delete_guard on public.gtm_story_assets;
drop trigger gtm_piece_preserve_authority on public.gtm_story_assets;
drop trigger gtm_piece_legacy_decision_guard on public.gtm_story_asset_channels;
drop trigger gtm_piece_stage_reopened on public.gtm_story_stage_decisions;
drop trigger gtm_piece_calendar_freeze on public.gtm_content_items;
drop trigger gtm_piece_story_delivery_guard on public.gtm_stories;

-- The surviving sender's claim, unchanged except that no shared piece or delivery can exist any more.
create or replace function public.gtm_claim_legacy_send(p_calendar_id text,p_expected jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare c public.gtm_content_items; ch text;
begin
 perform public.gtm_delivery_require_service();
 select * into c from public.gtm_content_items where id=p_calendar_id;
 if c.story_id is not null then perform 1 from public.gtm_stories where id=c.story_id for update; end if;
 select * into c from public.gtm_content_items where id=p_calendar_id for update;
 if not found or c.status<>'approved' or c.zernio_post_id is not null then raise exception 'post is already claimed or no longer approved' using errcode='PT409'; end if;
 if p_expected is null or jsonb_build_object('body',c.body,'media',c.media,'assets',c.story_assets,'date',c.date,'time',c.time,'channels',c.channels,'story_id',c.story_id,'approved_hash',c.approved_hash) is distinct from p_expected->'calendar' then raise exception 'post changed before sending' using errcode='PT409'; end if;
 perform 1 from public.gtm_story_assets where id=any(c.story_assets) order by id for update;
 perform 1 from public.gtm_story_asset_channels where asset_id=any(c.story_assets) order by asset_id,channel for update;
 if exists(select 1 from jsonb_to_recordset(coalesce(p_expected->'assets','[]')) x(id text,sha256 text,revision bigint) left join public.gtm_story_assets a on a.id=x.id where a.id is null or a.sha256 is distinct from x.sha256 or a.revision is distinct from x.revision) then raise exception 'asset changed before sending' using errcode='PT409'; end if;
 if exists(select 1 from public.gtm_stories where id=c.story_id and held_at is not null)
 or exists(select 1 from public.gtm_story_feedback f join public.gtm_story_assets a on a.id=f.asset_id where a.story_id=c.story_id and f.resolved_at is null and f.body like '[approved with note:%') then raise exception 'publishing is held or waiting for an accepted fix' using errcode='22023'; end if;
 if c.story_id is not null and exists(select 1 from public.gtm_story_assets a cross join unnest(c.channels) target_channel(value) where a.id=any(c.story_assets) and a.kind<>'link' and (coalesce(a.stage,'final')<>'final' or not exists(select 1 from public.gtm_story_asset_channels r where r.asset_id=a.id and r.channel=target_channel.value and r.status='approved' and r.approved_sha256=a.sha256))) then raise exception 'content approval changed before sending' using errcode='PT409'; end if;
 if exists(select 1 from public.gtm_stories st where st.id=c.story_id and nullif(btrim(st.third_party_who),'') is not null and not exists(select 1 from public.gtm_story_stage_decisions a where a.story_id=st.id and a.stage='final' and a.party='third_party' and btrim(coalesce(a.who,''))=btrim(st.third_party_who) and a.decision='approved' and a.assets @> (select coalesce(jsonb_agg(jsonb_build_object('asset_id',m.id,'sha256',m.sha256)),'[]'::jsonb) from public.gtm_story_assets m where m.story_id=st.id and m.kind in ('video','image') and exists(select 1 from public.gtm_story_asset_channels r where r.asset_id=m.id)) and not exists(select 1 from public.gtm_story_stage_decisions n where n.story_id=st.id and n.stage='final' and n.party='third_party' and btrim(coalesce(n.who,''))=btrim(st.third_party_who) and n.decision in ('changes','reopened') and n.decided_at>=a.decided_at))) then raise exception 'third-party approval changed before sending' using errcode='PT409'; end if;
 for ch in select distinct unnest(c.channels) order by 1 loop
 perform pg_advisory_xact_lock(hashtextextended('gtm-social-slot:'||ch||':'||c.date::text,0));
 end loop;
 if exists(select 1 from public.gtm_content_items other where other.id<>c.id and other.channels && c.channels and other.date=c.date and (other.status in ('scheduled','published') or other.zernio_post_id is not null)) then raise exception 'publishing slot was taken; replan' using errcode='PT409'; end if;
 update public.gtm_content_items set zernio_post_id='pending' where id=c.id;
 return true;
end $$;

revoke all on function public.gtm_claim_legacy_send(text,jsonb) from public,anon,authenticated;
grant execute on function public.gtm_claim_legacy_send(text,jsonb) to service_role;

-- Delivery ledger (20261017030000).
drop function public.gtm_prepare_piece_delivery(text,text,date,time,text,jsonb,text);
drop function public.gtm_prepare_piece_deliveries(text,jsonb,jsonb,text);
drop function public.gtm_claim_piece_delivery(uuid,boolean);
drop function public.gtm_start_piece_send(uuid,uuid,jsonb);
drop function public.gtm_record_piece_delivery(uuid,uuid,text,text,text,text,timestamptz);
drop function public.gtm_replan_unsent_delivery(uuid,date,time,text);
drop function public.gtm_release_piece_delivery(uuid);
drop function public.gtm_resend_uncertain_delivery(uuid,uuid);
drop function public.gtm_resolve_uncertain_delivery(uuid,text);
drop function public.gtm_retire_piece_delivery(uuid,text);
drop function public.gtm_reviewer_decide_piece_video(text,text,text,text,bigint,text);
drop function public.gtm_piece_delivery_hold(public.gtm_piece_deliveries,boolean);
drop function public.gtm_piece_ledger_write(boolean);
drop function public.gtm_piece_calendar_freeze();
drop function public.gtm_piece_preserve_authority();
drop function public.gtm_piece_story_delivery_guard();

-- Shared piece review (20261017020000).
drop function public.gtm_piece_snapshot(text);
drop function public.gtm_piece_candidates(text);
drop function public.gtm_configure_piece_review(text,text,text,text[],jsonb);
drop function public.gtm_decide_piece_part(text,text,text,text,text,bigint);
drop function public.gtm_complete_piece_fix(uuid,text,bigint,text,text,boolean);
drop function public.gtm_save_piece_text(text,text,text,bigint);
drop function public.gtm_convert_piece_legacy_fix(text,uuid,text,text,bigint);
drop function public.gtm_set_piece_dispatch(text,jsonb,boolean);
drop function public.gtm_release_piece_review(text);
drop function public.gtm_piece_asset_changed();
drop function public.gtm_piece_asset_identity_guard();
drop function public.gtm_piece_asset_delete_guard();
drop function public.gtm_piece_legacy_decision_guard();
drop function public.gtm_piece_stage_reopened();
drop function public.gtm_piece_asset_fingerprint(public.gtm_story_assets);
drop function public.gtm_piece_require_actor(boolean);

-- The tables, children first. Their own triggers and policies go with them.
drop table public.gtm_piece_delivery_attempts;
drop table public.gtm_piece_deliveries;
drop table public.gtm_piece_decision_events;
drop table public.gtm_piece_fixes;
drop table public.gtm_piece_part_decisions;
drop table public.gtm_piece_reviews;

-- The trigger functions only the dropped tables used.
drop function public.gtm_piece_record_decision_event();
drop function public.gtm_piece_delivery_owner_guard();
drop function public.gtm_piece_record_release();

commit;
