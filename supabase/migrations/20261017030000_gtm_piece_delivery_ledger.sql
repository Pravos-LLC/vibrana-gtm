begin;
-- One frozen delivery per piece and channel. Draft review and delivery never share a status.
-- Applies after 20261017020000_gtm_shared_piece_review (which owns gtm_set_piece_dispatch).
--
-- Recovery paths, all service-only and all under the story lock plus the channel/day lock:
--   prepared / failed with no provider post -> gtm_replan_unsent_delivery (move; holds do not apply,
--     moving is not dispatch) or gtm_release_piece_delivery (drop the reservation, free the day).
--   uncertain, inside the provider's 24 h idempotency window -> gtm_resend_uncertain_delivery returns
--     the frozen request and claim token; re-POST with the same key gtm-delivery-<id>-<claim_token>,
--     so the provider returns the original post if it exists and creates exactly one otherwise.
--   uncertain with no provider post, after a complete provider scan -> gtm_resolve_uncertain_delivery
--     records the evidence and marks it failed; the normal failed -> retry path then runs.
--   failed WITH a provider post that was cancelled or deleted at the provider ->
--     gtm_retire_piece_delivery records the evidence on the attempt (provider id kept, retired_at set),
--     frees the channel/day and the piece's channel, so a new delivery can be prepared. An uncertain
--     delivery with a provider id is first settled by a provider read recorded through
--     gtm_record_piece_delivery. The reconciler must keep reading retired provider ids for a while
--     (attempts where retired_at is not null, e.g. the last 14 days) and alert, not act, if one
--     reports scheduled or published: the provider resurrected a post the ledger let go of.
-- A delivery with no live provider post (provider_id null: never sent, or definitively rejected)
-- dispatches only while the current shared decisions approve exactly the versions it froze;
-- otherwise release it and prepare again. A same-key resend of an uncertain create is exempt.
create table public.gtm_piece_deliveries (
 id uuid primary key default gen_random_uuid(),
 story_id text not null references public.gtm_piece_reviews(story_id),
 channel text not null check(channel in ('linkedin','instagram','youtube')),
 calendar_id text not null unique references public.gtm_content_items(id),
 slot_date date not null, slot_time time not null, timezone text not null,
 review_snapshot jsonb not null,
 state text not null default 'prepared' check(state in ('prepared','uploading','sending','uncertain','scheduled','published','failed')),
 request jsonb, claim_token uuid, claimed_at timestamptz,
 provider_id text, publication_url text, published_at timestamptz, error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(story_id,channel), unique(channel,slot_date)
);
create table public.gtm_piece_delivery_attempts (
 id uuid primary key,
 -- A released delivery keeps its outbound evidence: the attempt survives with its own identity.
 delivery_id uuid references public.gtm_piece_deliveries(id) on delete set null,
 story_id text not null, channel text not null, calendar_id text not null,
 request jsonb not null, started_at timestamptz not null default now(),
 posts integer not null default 1 check (posts > 0), last_posted_at timestamptz not null default now(),
 retired_at timestamptz,
 state text not null default 'sending', provider_id text, error text,
 updated_at timestamptz not null default now()
);
create index gtm_piece_delivery_attempts_delivery_idx on public.gtm_piece_delivery_attempts(delivery_id,started_at);
create index gtm_piece_delivery_attempts_story_idx on public.gtm_piece_delivery_attempts(story_id,started_at);
create index gtm_piece_delivery_attempts_retired_idx on public.gtm_piece_delivery_attempts(retired_at) where retired_at is not null;
alter table public.gtm_piece_delivery_attempts enable row level security;
revoke all on public.gtm_piece_delivery_attempts from public,anon,authenticated,service_role;
grant select on public.gtm_piece_delivery_attempts to authenticated,service_role;
create policy gtm_piece_delivery_attempts_owner_read on public.gtm_piece_delivery_attempts for select to authenticated using(coalesce((select auth.jwt())->'app_metadata'->>'gtm_owner'='true',false));
create index gtm_piece_deliveries_state_idx on public.gtm_piece_deliveries(state);
create table public.gtm_piece_decision_events (
 id uuid primary key default gen_random_uuid(),
 -- No foreign key: append-only evidence outlives a release and a deleted Story.
 story_id text not null,
 part text not null, fingerprint text not null, status text not null,
 decided_by uuid references auth.users(id) on delete set null,
 decided_at timestamptz, recorded_at timestamptz not null default now(),
 source_role text not null
);
create index gtm_piece_decision_events_story_idx on public.gtm_piece_decision_events(story_id,recorded_at);
create index gtm_piece_decision_events_owner_idx on public.gtm_piece_decision_events(decided_by);
alter table public.gtm_piece_deliveries enable row level security;
alter table public.gtm_piece_decision_events enable row level security;
revoke all on public.gtm_piece_deliveries,public.gtm_piece_decision_events from public,anon,authenticated,service_role;
grant select on public.gtm_piece_deliveries,public.gtm_piece_decision_events to authenticated,service_role;
create policy gtm_piece_deliveries_owner_read on public.gtm_piece_deliveries for select to authenticated using(coalesce((select auth.jwt())->'app_metadata'->>'gtm_owner'='true',false));
create policy gtm_piece_decision_events_owner_read on public.gtm_piece_decision_events for select to authenticated using(coalesce((select auth.jwt())->'app_metadata'->>'gtm_owner'='true',false));

create function public.gtm_piece_record_decision_event()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.gtm_piece_decision_events(story_id,part,fingerprint,status,decided_by,decided_at,source_role)
 values(new.story_id,new.part,new.fingerprint,new.status,new.decided_by,new.decided_at,coalesce((select auth.jwt())->>'role','migration'));
 return new;
end $$;
revoke all on function public.gtm_piece_record_decision_event() from public,anon,authenticated;
insert into public.gtm_piece_decision_events(story_id,part,fingerprint,status,decided_by,decided_at,source_role) select story_id,part,fingerprint,status,decided_by,decided_at,'migration' from public.gtm_piece_part_decisions;
create trigger gtm_piece_decision_event after insert or update on public.gtm_piece_part_decisions for each row execute function public.gtm_piece_record_decision_event();

create function public.gtm_delivery_require_service()
returns void language plpgsql set search_path='' as $$
begin
 if coalesce((select auth.jwt())->>'role','') <> 'service_role' then raise exception 'delivery operations require service access' using errcode='42501'; end if;
end $$;
revoke all on function public.gtm_delivery_require_service() from public,anon,authenticated;

-- Calendar dispatch markers (status, zernio_post_id, published_at) of a delivery-backed row change only
-- inside the ledger functions, which set this transaction-local marker around their calendar writes.
-- This is advisory, not a privilege boundary: any role can call set_config(), so it stops stale or
-- careless service_role code paths (legacy sync, reschedule, hand fixes), not a deliberate bypass.
create function public.gtm_piece_ledger_write(p_on boolean)
returns void language plpgsql set search_path='' as $$
begin
 perform set_config('gtm.piece_ledger_write',case when p_on then 'on' else '' end,true);
end $$;
revoke all on function public.gtm_piece_ledger_write(boolean) from public,anon,authenticated,service_role;

-- Story + asset locks bind eligibility to the frozen versions. A per-channel/day advisory lock also
-- covers the legacy calendar, while the unique constraint is the final concurrent reservation guard.
-- A new calendar row takes its pillar from: the row being reused, p_pillar, the Story's other calendar
-- rows, then its content candidate. With none of them, scheduling asks for one instead of guessing.
create function public.gtm_prepare_piece_delivery(p_story_id text,p_channel text,p_date date,p_time time,p_timezone text,p_expected jsonb,p_pillar text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; d public.gtm_piece_deliveries; p public.gtm_piece_reviews; cal_id text; title_text text; last_day date; candidate_count integer; pillar_value text;
begin
 perform public.gtm_delivery_require_service();
 if p_pillar is not null and p_pillar not in ('proof','perspective','build','lists') then raise exception 'unknown content pillar' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=p_story_id for update;
 select * into d from public.gtm_piece_deliveries where story_id=p_story_id and channel=p_channel;
 if found then return to_jsonb(d); end if;
 select * into p from public.gtm_piece_reviews where story_id=p_story_id;
 if not found or not(p_channel=any(p.channels)) then raise exception 'channel is not selected for this piece' using errcode='22023'; end if;
 perform 1 from public.gtm_story_assets where id in (p.text_asset_id,p.video_asset_id) order by id for update;
 s:=public.gtm_piece_snapshot(p_story_id);
 if p_expected is null or s->'text'->>'fingerprint' is distinct from p_expected->>'text' or s->'video'->>'fingerprint' is distinct from p_expected->>'video' then raise exception 'piece changed before scheduling' using errcode='PT409'; end if;
 if (s->>'ready')::boolean is distinct from true then raise exception 'publishing blocked: %',s->'blockers' using errcode='22023'; end if;
 if p_date is null or p_time is null or p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'invalid publishing slot' using errcode='22023'; end if;
 if ((p_date::text||' '||p_time::text)::timestamp at time zone p_timezone) < now()+interval '30 minutes' then raise exception 'publishing slot must be at least 30 minutes ahead' using errcode='22023'; end if;
 select max(ends_on) into last_day from public.gtm_seasons;
 if last_day is not null and p_date>last_day then raise exception 'reserve bank: slot exceeds the last season' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('gtm-social-slot:'||p_channel||':'||p_date::text,0));
 if exists(select 1 from public.gtm_piece_deliveries where channel=p_channel and slot_date=p_date)
 or exists(select 1 from public.gtm_content_items where p_channel=any(channels) and date=p_date and (status in ('scheduled','published') or zernio_post_id is not null)) then raise exception 'publishing slot was taken; replan' using errcode='PT409'; end if;
 if exists(select 1 from public.gtm_content_items where story_id=p_story_id and p_channel=any(channels) and (status in ('scheduled','published') or zernio_post_id is not null)) then raise exception 'this channel already has a queued or published version; reconcile it before creating another delivery' using errcode='22023'; end if;
 select count(*),min(id) into candidate_count,cal_id from public.gtm_content_items where story_id=p_story_id and p_channel=any(channels);
 if candidate_count>1 or exists(select 1 from public.gtm_content_items where id=cal_id and cardinality(channels)<>1) then raise exception 'competing calendar rows require reconciliation before scheduling' using errcode='22023'; end if;
 cal_id:=coalesce(cal_id,p_story_id||'-'||p_channel);
 if exists(select 1 from public.gtm_content_items where id=cal_id and (story_id is distinct from p_story_id or channels is distinct from array[p_channel])) then raise exception 'calendar identity collision requires reconciliation' using errcode='22023'; end if;
 select title into title_text from public.gtm_stories where id=p_story_id;
 select c.pillar into pillar_value from public.gtm_content_items c where c.id=cal_id;
 pillar_value:=coalesce(pillar_value,p_pillar,
  (select c.pillar from public.gtm_content_items c where c.story_id=p_story_id order by c.updated_at desc,c.id limit 1),
  (select k.pillar from public.gtm_content_candidates k where k.gtm_story_id=p_story_id order by k.updated_at desc,k.id limit 1));
 if pillar_value is null then raise exception 'choose the content pillar for this piece before scheduling' using errcode='22023'; end if;
 insert into public.gtm_content_items(id,story_id,week,date,time,pillar,title,format,channels,status,body,media,story_assets,copy_path)
 values(cal_id,p_story_id,extract(week from p_date)::integer,p_date,to_char(p_time,'HH24:MI'),pillar_value,title_text,'video',array[p_channel],'drafted',s->'text'->'asset'->>'body',jsonb_build_array(s->'video'->'asset'->>'storage_path'),array[p.text_asset_id,p.video_asset_id],s->'text'->'asset'->>'source')
 on conflict(id) do update set week=excluded.week,date=excluded.date,time=excluded.time,body=excluded.body,media=excluded.media,story_assets=excluded.story_assets,copy_path=excluded.copy_path,status='drafted';
 insert into public.gtm_piece_deliveries(story_id,channel,calendar_id,slot_date,slot_time,timezone,review_snapshot)
 values(p_story_id,p_channel,cal_id,p_date,p_time,p_timezone,s) returning * into d;
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set zernio_post_id='pending' where id=cal_id;
 perform public.gtm_piece_ledger_write(false);
 return to_jsonb(d);
end $$;
revoke all on function public.gtm_prepare_piece_delivery(text,text,date,time,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.gtm_prepare_piece_delivery(text,text,date,time,text,jsonb,text) to service_role;


-- Reserve all selected channel slots before doing any external work. A collision on the last
-- channel rolls back the whole batch, so a retry cannot split sibling channels across days.
create function public.gtm_prepare_piece_deliveries(p_story_id text,p_slots jsonb,p_expected jsonb,p_pillar text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare slot jsonb; lock_key text; deliveries jsonb:='[]'::jsonb;
begin
 perform public.gtm_delivery_require_service();
 if p_slots is null or jsonb_typeof(p_slots)<>'array' or jsonb_array_length(p_slots) not between 1 and 3 then raise exception 'choose one to three channel slots' using errcode='22023'; end if;
 if (select count(distinct value->>'channel') from jsonb_array_elements(p_slots))<>jsonb_array_length(p_slots) then raise exception 'duplicate channel slots' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=p_story_id for update;
 for lock_key in select distinct 'gtm-social-slot:'||(value->>'channel')||':'||(value->>'date') from jsonb_array_elements(p_slots) order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended(lock_key,0));
 end loop;
 for slot in select value from jsonb_array_elements(p_slots) order by value->>'channel' loop
  deliveries:=deliveries||jsonb_build_array(public.gtm_prepare_piece_delivery(p_story_id,slot->>'channel',(slot->>'date')::date,(slot->>'time')::time,slot->>'timezone',p_expected,p_pillar));
 end loop;
 return deliveries;
end $$;
revoke all on function public.gtm_prepare_piece_deliveries(text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.gtm_prepare_piece_deliveries(text,jsonb,jsonb,text) to service_role;

-- Current operational holds still apply to frozen content. While no provider post exists (never sent,
-- or a definitive rejection retried under a new key), the frozen versions must still be the approved
-- ones: John may have changed or replaced them meanwhile. A retry in place of a live provider post,
-- and a same-key resend of an uncertain create (p_check_approval false), keep the frozen request.
create function public.gtm_piece_delivery_hold(d public.gtm_piece_deliveries,p_check_approval boolean default true)
returns void language plpgsql set search_path='' as $$
declare required_party text; held timestamptz; video jsonb; s jsonb;
begin
 select third_party_who,held_at into required_party,held from public.gtm_stories where id=d.story_id;
 if held is not null then raise exception 'publishing is on hold' using errcode='22023'; end if;
 if not exists(select 1 from public.gtm_piece_reviews where story_id=d.story_id and dispatch_enabled) then raise exception 'new dispatch is paused for this piece' using errcode='22023'; end if;
 video:=jsonb_build_array(jsonb_build_object('asset_id',d.review_snapshot->'video'->'asset'->>'id','sha256',d.review_snapshot->'video'->'asset'->>'sha256'));
 required_party:=nullif(btrim(required_party),'');
 if required_party is not null and not exists(select 1 from public.gtm_story_stage_decisions a where a.story_id=d.story_id and a.stage='final' and a.party='third_party' and btrim(coalesce(a.who,''))=required_party and a.decision='approved' and a.assets @> video and not exists(select 1 from public.gtm_story_stage_decisions n where n.story_id=a.story_id and n.stage='final' and n.party='third_party' and btrim(coalesce(n.who,''))=required_party and n.decision in ('changes','reopened') and n.assets @> video and n.decided_at>=a.decided_at)) then raise exception 'waiting for third-party approval of the frozen video' using errcode='22023'; end if;
 if p_check_approval and d.provider_id is null then
  s:=public.gtm_piece_snapshot(d.story_id);
  if s is null or s->'text'->>'status' is distinct from 'approved' or s->'video'->>'status' is distinct from 'approved'
     or s->'text'->>'fingerprint' is distinct from d.review_snapshot->'text'->>'fingerprint'
     or s->'video'->>'fingerprint' is distinct from d.review_snapshot->'video'->>'fingerprint' then
   raise exception 'the piece changed since this delivery was prepared; release and prepare it again' using errcode='22023'; end if;
 end if;
end $$;
revoke all on function public.gtm_piece_delivery_hold(public.gtm_piece_deliveries,boolean) from public,anon,authenticated;

create function public.gtm_claim_piece_delivery(p_id uuid,p_retry boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries;
begin
 perform public.gtm_delivery_require_service();
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform public.gtm_piece_delivery_hold(d);
 if d.state='prepared' or (d.state='uploading' and d.claimed_at<now()-interval '15 minutes') or (d.state='failed' and p_retry) then
  update public.gtm_piece_deliveries set state='uploading',claim_token=gen_random_uuid(),claimed_at=now(),updated_at=now(),error=null where id=p_id returning * into d;
  return to_jsonb(d);
 end if;
 return null;
end $$;
revoke all on function public.gtm_claim_piece_delivery(uuid,boolean) from public,anon,authenticated;
grant execute on function public.gtm_claim_piece_delivery(uuid,boolean) to service_role;

create function public.gtm_start_piece_send(p_id uuid,p_token uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries;
begin
 perform public.gtm_delivery_require_service();
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found or d.state<>'uploading' or d.claim_token is distinct from p_token or p_token is null then raise exception 'delivery is owned by another worker' using errcode='PT409'; end if;
 perform public.gtm_piece_delivery_hold(d);
 if p_request is null or jsonb_typeof(p_request)<>'object' or (d.request is not null and d.request is distinct from p_request) then raise exception 'frozen provider request cannot change' using errcode='22023'; end if;
 insert into public.gtm_piece_delivery_attempts(id,delivery_id,story_id,channel,calendar_id,request) values(p_token,p_id,d.story_id,d.channel,d.calendar_id,p_request);
 update public.gtm_piece_deliveries set state='sending',request=p_request,updated_at=now() where id=p_id returning * into d;
 -- A pending marker prevents old dispatch paths from interpreting this as an unsent post.
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set zernio_post_id=coalesce(d.provider_id,'pending') where id=d.calendar_id;
 perform public.gtm_piece_ledger_write(false);
 return to_jsonb(d);
end $$;
revoke all on function public.gtm_start_piece_send(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.gtm_start_piece_send(uuid,uuid,jsonb) to service_role;

-- Used for direct responses and read-only provider reconciliation. Caller records the observed
-- state; a published delivery is terminal, and a different provider id can never replace evidence.
create function public.gtm_record_piece_delivery(p_id uuid,p_token uuid,p_provider_id text,p_state text,p_url text,p_error text,p_published_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries;
begin
 perform public.gtm_delivery_require_service();
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found or p_token is null or d.claim_token is distinct from p_token then raise exception 'stale delivery worker' using errcode='PT409'; end if;
 if p_state is null or p_state not in ('scheduled','published','failed','uncertain') then raise exception 'invalid delivery outcome' using errcode='22023'; end if;
 if d.provider_id is not null and d.provider_id is distinct from p_provider_id then raise exception 'provider identity cannot change' using errcode='22023'; end if;
 if p_state in ('scheduled','published') and d.request is null then raise exception 'no provider request was recorded' using errcode='22023'; end if;
 if p_state in ('scheduled','published') and nullif(btrim(p_provider_id),'') is null then raise exception 'provider id is required' using errcode='22023'; end if;
 if d.state='published' and p_state<>'published' then return to_jsonb(d); end if;
 if d.state not in ('uploading','sending','uncertain','scheduled','failed','published') then raise exception 'delivery was never claimed' using errcode='22023'; end if;
 update public.gtm_piece_delivery_attempts set state=p_state,provider_id=p_provider_id,error=p_error,updated_at=now() where id=p_token and delivery_id=p_id;
 -- Published without a provider timestamp falls back to the time it was observed, as the legacy sender did.
 update public.gtm_piece_deliveries set state=p_state,provider_id=p_provider_id,publication_url=coalesce(nullif(p_url,''),publication_url),published_at=case when p_state='published' then coalesce(p_published_at,published_at,now()) else published_at end,error=p_error,updated_at=now() where id=p_id returning * into d;
 -- An uncertain outcome is not news about the calendar: a scheduled row stays scheduled.
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set status=case p_state when 'published' then 'published' when 'scheduled' then 'scheduled' when 'failed' then 'failed' else status end,
 zernio_post_id=coalesce(p_provider_id,case when d.request is not null then 'pending' else null end),
 urls=case when nullif(p_url,'') is not null then coalesce(urls,'{}'::jsonb)||jsonb_build_object(d.channel,p_url) else urls end,
 published_at=case when p_state='published' then coalesce(d.published_at,published_at) else published_at end,updated_at=now() where id=d.calendar_id;
 perform public.gtm_piece_ledger_write(false);
 return to_jsonb(d);
end $$;
revoke all on function public.gtm_record_piece_delivery(uuid,uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.gtm_record_piece_delivery(uuid,uuid,text,text,text,text,timestamptz) to service_role;

create function public.gtm_piece_calendar_freeze()
returns trigger language plpgsql set search_path='' as $$
declare d public.gtm_piece_deliveries;
begin
 select * into d from public.gtm_piece_deliveries where calendar_id=old.id;
 if found and (new.body is distinct from old.body or new.media is distinct from old.media or new.story_assets is distinct from old.story_assets or new.channels is distinct from old.channels or new.story_id is distinct from old.story_id or new.copy_path is distinct from old.copy_path or new.date is distinct from d.slot_date or new.time is distinct from to_char(d.slot_time,'HH24:MI')) then
 raise exception 'queued content is frozen; edit the separate piece draft' using errcode='22023'; end if;
 if found and coalesce(current_setting('gtm.piece_ledger_write',true),'')<>'on' and (new.status is distinct from old.status or new.zernio_post_id is distinct from old.zernio_post_id or new.published_at is distinct from old.published_at) then
 raise exception 'delivery status belongs to the shared delivery ledger; use its recovery functions' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function public.gtm_piece_calendar_freeze() from public,anon,authenticated;
create trigger gtm_piece_calendar_freeze before update on public.gtm_content_items for each row execute function public.gtm_piece_calendar_freeze();
-- Shared third-party review binds only the selected final video. The bearer link or claimed
-- invite remains the credential; no private owner notes or text decisions are returned.
create function public.gtm_reviewer_decide_piece_video(p_asset_id text,p_decision text,p_note text,p_sha256 text,p_revision bigint,p_token_sha256 text default null)
returns void language plpgsql security definer set search_path='' as $$
declare a public.gtm_story_assets; p public.gtm_piece_reviews; who text; valid_invite boolean;
begin
 if p_decision is null or p_decision not in ('approved','changes','note') or p_note is null or length(p_note)>5000 or (p_decision<>'approved' and btrim(p_note)='') then raise exception 'invalid reviewer decision' using errcode='22023'; end if;
 select * into a from public.gtm_story_assets where id=p_asset_id;
 if not found then raise exception 'not found' using errcode='42501'; end if;
 perform 1 from public.gtm_stories where id=a.story_id for update;
 select * into p from public.gtm_piece_reviews where story_id=a.story_id and video_asset_id=a.id;
 if not found then raise exception 'not found' using errcode='42501'; end if;
 select btrim(third_party_who) into who from public.gtm_stories where id=a.story_id;
 select exists(select 1 from public.gtm_reviewer_invites i where btrim(i.party)=who and i.revoked_at is null and i.expires_at>now()
   and ((coalesce((select auth.jwt())->>'role','')='service_role' and p_token_sha256 is not null and i.token_sha256=p_token_sha256)
   or ((select auth.uid()) is not null and exists(select 1 from public.gtm_reviewer_invite_accounts ia where ia.invite_id=i.id and ia.user_id=(select auth.uid()))))) into valid_invite;
 if not valid_invite or who is null or who='' then raise exception 'not found' using errcode='42501'; end if;
 perform public.gtm_reviewer_throttle(who);
 select * into a from public.gtm_story_assets where id=p_asset_id for update;
 if a.sha256 is distinct from p_sha256 or a.revision is distinct from p_revision then raise exception 'video changed; reload and review the current version' using errcode='PT409'; end if;
 if coalesce(a.stage,'final')<>'final' or not exists(select 1 from public.gtm_piece_part_decisions d where d.story_id=a.story_id and d.part='video' and d.status='approved' and d.fingerprint=public.gtm_piece_asset_fingerprint(a)) then raise exception 'the final video is not ready for external review' using errcode='22023'; end if;
 insert into public.gtm_reviewer_asset_decisions(story_id,asset_id,asset_sha256,revision,party,decision,note)
 values(a.story_id,a.id,a.sha256,a.revision,who,p_decision,btrim(p_note));
 if p_decision in ('approved','changes') then
  insert into public.gtm_story_stage_decisions(story_id,stage,party,who,decision,note,assets)
  values(a.story_id,'final','third_party',who,p_decision,btrim(p_note),jsonb_build_array(jsonb_build_object('asset_id',a.id,'sha256',a.sha256,'revision',a.revision)));
  if p_decision='approved' then update public.gtm_stories set held_at=null,held_by=null,hold_who=null,hold_note='' where id=a.story_id and btrim(hold_who)=who; end if;
 end if;
end $$;
revoke all on function public.gtm_reviewer_decide_piece_video(text,text,text,text,bigint,text) from public,anon;
grant execute on function public.gtm_reviewer_decide_piece_video(text,text,text,text,bigint,text) to authenticated,service_role;
-- The surviving legacy sender shares the same channel/day lock and cannot duplicate its own
-- in-flight request. It also refuses an adopted piece even if a stale calendar tab invokes it.
create function public.gtm_claim_legacy_send(p_calendar_id text,p_expected jsonb)
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
 if exists(select 1 from public.gtm_piece_reviews p where p.story_id=c.story_id) then raise exception 'use shared piece dispatch' using errcode='22023'; end if;
 for ch in select distinct unnest(c.channels) order by 1 loop
 perform pg_advisory_xact_lock(hashtextextended('gtm-social-slot:'||ch||':'||c.date::text,0));
 end loop;
 if exists(select 1 from public.gtm_piece_deliveries d where d.channel=any(c.channels) and d.slot_date=c.date)
 or exists(select 1 from public.gtm_content_items other where other.id<>c.id and other.channels && c.channels and other.date=c.date and (other.status in ('scheduled','published') or other.zernio_post_id is not null)) then raise exception 'publishing slot was taken; replan' using errcode='PT409'; end if;
 update public.gtm_content_items set zernio_post_id='pending' where id=c.id;
 return true;
end $$;
revoke all on function public.gtm_claim_legacy_send(text,jsonb) from public,anon,authenticated;
grant execute on function public.gtm_claim_legacy_send(text,jsonb) to service_role;
create function public.gtm_piece_preserve_authority()
returns trigger language plpgsql set search_path='' as $$
declare p public.gtm_piece_reviews;
begin
 select * into p from public.gtm_piece_reviews where story_id=new.story_id;
 if found then new.metadata:=(coalesce(new.metadata,'{}'::jsonb)-'shared_review_part')||jsonb_build_object('shared_review',true)||case new.id when p.text_asset_id then jsonb_build_object('shared_review_part','text') when p.video_asset_id then jsonb_build_object('shared_review_part','video') else '{}'::jsonb end; end if;
 return new;
end $$;
revoke all on function public.gtm_piece_preserve_authority() from public,anon,authenticated;
create trigger gtm_piece_preserve_authority before insert or update on public.gtm_story_assets for each row execute function public.gtm_piece_preserve_authority();
-- Only an unattempted upload or a definitive rejection with no provider post may move to a new
-- slot. Old outbound attempts remain immutable evidence; uncertain creates cannot reach this path.
create function public.gtm_replan_unsent_delivery(p_id uuid,p_date date,p_time time,p_timezone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries; last_day date; lock_key text;
begin
 perform public.gtm_delivery_require_service();
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if d.state not in ('prepared','failed') or d.provider_id is not null then raise exception 'reconcile the provider before moving this delivery' using errcode='PT409'; end if;
 -- Moving a reservation is not dispatch: holds and pauses are rechecked when a worker claims it.
 if p_date is null or p_time is null or p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'invalid publishing slot' using errcode='22023'; end if;
 if ((p_date::text||' '||p_time::text)::timestamp at time zone p_timezone)<now()+interval '30 minutes' then raise exception 'new slot must be at least 30 minutes ahead' using errcode='22023'; end if;
 select max(ends_on) into last_day from public.gtm_seasons;
 if last_day is not null and p_date>last_day then raise exception 'reserve bank: slot exceeds the last season' using errcode='22023'; end if;
 for lock_key in select distinct k from unnest(array['gtm-social-slot:'||d.channel||':'||d.slot_date::text,'gtm-social-slot:'||d.channel||':'||p_date::text]) k order by k loop perform pg_advisory_xact_lock(hashtextextended(lock_key,0)); end loop;
 if exists(select 1 from public.gtm_piece_deliveries where id<>d.id and channel=d.channel and slot_date=p_date)
 or exists(select 1 from public.gtm_content_items where id<>d.calendar_id and d.channel=any(channels) and date=p_date and (status in ('scheduled','published') or zernio_post_id is not null)) then raise exception 'publishing slot was taken; replan' using errcode='PT409'; end if;
 update public.gtm_piece_deliveries set slot_date=p_date,slot_time=p_time,timezone=p_timezone,state='prepared',request=null,claim_token=null,claimed_at=null,error=null,updated_at=now() where id=p_id returning * into d;
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set week=extract(week from p_date)::integer,date=p_date,time=to_char(p_time,'HH24:MI'),zernio_post_id='pending',status='drafted' where id=d.calendar_id;
 perform public.gtm_piece_ledger_write(false);
 return to_jsonb(d);
end $$;
revoke all on function public.gtm_replan_unsent_delivery(uuid,date,time,text) from public,anon,authenticated;
grant execute on function public.gtm_replan_unsent_delivery(uuid,date,time,text) to service_role;

-- Drop a reservation that never reached the provider: a prepared delivery, a stale upload that never
-- recorded a request, or a definitive rejection with no provider post. The channel/day is free again,
-- the calendar row returns to drafted, and earlier attempts stay as evidence (delivery_id set null).
create function public.gtm_release_piece_delivery(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries;
begin
 perform public.gtm_delivery_require_service();
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 if d.provider_id is not null or not (d.state='prepared' or d.state='failed'
    or (d.state='uploading' and d.request is null and d.claimed_at<now()-interval '15 minutes')) then
  raise exception 'only an unsent delivery can be released; reconcile the provider first' using errcode='PT409'; end if;
 perform pg_advisory_xact_lock(hashtextextended('gtm-social-slot:'||d.channel||':'||d.slot_date::text,0));
 delete from public.gtm_piece_deliveries where id=p_id;
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set status='drafted',zernio_post_id=null,updated_at=now() where id=d.calendar_id;
 perform public.gtm_piece_ledger_write(false);
 return jsonb_build_object('id',d.id,'storyId',d.story_id,'channel',d.channel,'calendarId',d.calendar_id,'slotDate',d.slot_date,'released',true);
end $$;
revoke all on function public.gtm_release_piece_delivery(uuid) from public,anon,authenticated;
grant execute on function public.gtm_release_piece_delivery(uuid) to service_role;

-- An uncertain create inside the provider's idempotency window is re-sent with the SAME key: this
-- returns the frozen request and claim token (key gtm-delivery-<id>-<claim_token>) and marks the
-- delivery sending, so only one worker re-POSTs. Holds and pauses apply: a re-POST may create the post.
-- The window is measured from the attempt's first request, with an hour of margin on Zernio's 24 h.
create function public.gtm_resend_uncertain_delivery(p_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries;
begin
 perform public.gtm_delivery_require_service();
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found or d.state<>'uncertain' or d.provider_id is not null or d.request is null or p_token is null or d.claim_token is distinct from p_token then
  raise exception 'only the current uncertain attempt can be re-sent' using errcode='PT409'; end if;
 perform public.gtm_piece_delivery_hold(d,false);
 if not exists(select 1 from public.gtm_piece_delivery_attempts a where a.id=p_token and a.delivery_id=p_id and a.started_at>now()-interval '23 hours') then
  raise exception 'the provider idempotency window has passed; verify the post is absent and resolve the delivery' using errcode='22023'; end if;
 update public.gtm_piece_delivery_attempts set posts=posts+1,last_posted_at=now(),state='sending',updated_at=now() where id=p_token;
 update public.gtm_piece_deliveries set state='sending',updated_at=now() where id=p_id returning * into d;
 return to_jsonb(d);
end $$;
revoke all on function public.gtm_resend_uncertain_delivery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gtm_resend_uncertain_delivery(uuid,uuid) to service_role;

-- An uncertain create with no provider post becomes failed only with recorded evidence (for example
-- "full provider scan, 1 of 1 pages, found no post with this calendarId") and not while its last
-- request may still be in flight. The existing failed -> retry path then sends with a new key.
create function public.gtm_resolve_uncertain_delivery(p_id uuid,p_evidence text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries; note text;
begin
 perform public.gtm_delivery_require_service();
 if p_evidence is null or length(btrim(p_evidence)) not between 10 and 2000 then raise exception 'record the evidence that no provider post exists' using errcode='22023'; end if;
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found or d.state<>'uncertain' or d.provider_id is not null then raise exception 'only an uncertain delivery with no provider post can be resolved' using errcode='PT409'; end if;
 if exists(select 1 from public.gtm_piece_delivery_attempts a where a.delivery_id=p_id and a.last_posted_at>now()-interval '15 minutes') then
  raise exception 'the last provider request is too recent; reconcile again later' using errcode='PT409'; end if;
 note:='Verified absent at the provider: '||btrim(p_evidence);
 update public.gtm_piece_delivery_attempts set state='failed',error=note,updated_at=now() where id=d.claim_token and delivery_id=p_id;
 update public.gtm_piece_deliveries set state='failed',error=note,updated_at=now() where id=p_id returning * into d;
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set status='failed',updated_at=now() where id=d.calendar_id;
 perform public.gtm_piece_ledger_write(false);
 return to_jsonb(d);
end $$;
revoke all on function public.gtm_resolve_uncertain_delivery(uuid,text) from public,anon,authenticated;
grant execute on function public.gtm_resolve_uncertain_delivery(uuid,text) to service_role;

-- A provider post that was cancelled or deleted at the provider (reconciled as failed with its
-- provider id) cannot be retried in place. With recorded evidence, and not while a request
-- may still be in flight, retire it: the attempt keeps the provider id and the evidence, the delivery
-- row goes (freeing the channel/day and the piece's channel), and the calendar row stays failed with
-- no live provider id or link for that channel, so a fresh gtm_prepare_piece_delivery reuses it with a
-- new key. Only failed deliveries are retired: never scheduled or published ones (no publication
-- history is lost), and never uncertain ones (settle those with a provider read first).
create function public.gtm_retire_piece_delivery(p_id uuid,p_evidence text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.gtm_piece_deliveries; note text;
begin
 perform public.gtm_delivery_require_service();
 if p_evidence is null or length(btrim(p_evidence)) not between 10 and 2000 then raise exception 'record the evidence that the provider post was cancelled or deleted' using errcode='22023'; end if;
 select * into d from public.gtm_piece_deliveries where id=p_id;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 perform 1 from public.gtm_stories where id=d.story_id for update;
 select * into d from public.gtm_piece_deliveries where id=p_id for update;
 if not found then raise exception 'delivery not found' using errcode='22023'; end if;
 if d.state<>'failed' or d.provider_id is null then
  raise exception 'only a failed delivery with a dead provider post can be retired; settle an uncertain one with a provider read first' using errcode='PT409'; end if;
 if exists(select 1 from public.gtm_piece_delivery_attempts a where a.delivery_id=p_id and a.last_posted_at>now()-interval '15 minutes') then
  raise exception 'the last provider request is too recent; reconcile again later' using errcode='PT409'; end if;
 note:='Provider post '||d.provider_id||' cancelled or deleted at the provider: '||btrim(p_evidence);
 perform pg_advisory_xact_lock(hashtextextended('gtm-social-slot:'||d.channel||':'||d.slot_date::text,0));
 update public.gtm_piece_delivery_attempts set state='failed',provider_id=coalesce(provider_id,d.provider_id),error=note,retired_at=now(),updated_at=now() where id=d.claim_token and delivery_id=p_id;
 delete from public.gtm_piece_deliveries where id=p_id;
 perform public.gtm_piece_ledger_write(true);
 update public.gtm_content_items set status='failed',zernio_post_id=null,urls=case when urls is null then null else urls-d.channel end,updated_at=now() where id=d.calendar_id and status<>'published';
 perform public.gtm_piece_ledger_write(false);
 return jsonb_build_object('id',d.id,'storyId',d.story_id,'channel',d.channel,'calendarId',d.calendar_id,'slotDate',d.slot_date,'providerId',d.provider_id,'retired',true);
end $$;
revoke all on function public.gtm_retire_piece_delivery(uuid,text) from public,anon,authenticated;
grant execute on function public.gtm_retire_piece_delivery(uuid,text) to service_role;

-- Deleting a Story or releasing its shared review with deliveries on record is refused in plain words:
-- release the unsent ones first; a piece with sent deliveries stays shared. A release is recorded.
create function public.gtm_piece_delivery_owner_guard()
returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.gtm_piece_deliveries d where d.story_id=old.story_id) then
  raise exception '% has shared deliveries; release its unsent deliveries first (sent deliveries are permanent)',old.story_id using errcode='22023'; end if;
 return old;
end $$;
revoke all on function public.gtm_piece_delivery_owner_guard() from public,anon,authenticated;
create trigger gtm_piece_delivery_owner_guard before delete on public.gtm_piece_reviews for each row execute function public.gtm_piece_delivery_owner_guard();

create function public.gtm_piece_story_delivery_guard()
returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.gtm_piece_deliveries d where d.story_id=old.id) then
  raise exception '% has shared deliveries; release its unsent deliveries first (sent deliveries are permanent)',old.id using errcode='22023'; end if;
 return old;
end $$;
revoke all on function public.gtm_piece_story_delivery_guard() from public,anon,authenticated;
create trigger gtm_piece_story_delivery_guard before delete on public.gtm_stories for each row execute function public.gtm_piece_story_delivery_guard();

create function public.gtm_piece_record_release()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.gtm_piece_decision_events(story_id,part,fingerprint,status,decided_by,decided_at,source_role)
 values(old.story_id,'piece','','released',(select auth.uid()),now(),coalesce((select auth.jwt())->>'role','migration'));
 return old;
end $$;
revoke all on function public.gtm_piece_record_release() from public,anon,authenticated;
create trigger gtm_piece_record_release after delete on public.gtm_piece_reviews for each row execute function public.gtm_piece_record_release();
commit;
