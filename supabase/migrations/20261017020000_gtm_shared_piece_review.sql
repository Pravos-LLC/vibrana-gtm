begin;
-- One text and one video per piece. Channel delivery is independent of content approval.
-- Additive, opt-in: no existing piece is migrated or released by applying this migration.
-- Scope: video pieces only (one copy + one video). Text-only posts, carousels, essays and newsletter
-- rows stay on the per-platform model, and so do the non-selected assets of an adopted piece (covers,
-- images, website/newsletter rows): their legacy decisions keep working.
-- Fingerprints use pgcrypto's digest(). Supabase enables it in `extensions`; fail clearly elsewhere.
create extension if not exists pgcrypto with schema extensions;
create table public.gtm_piece_reviews (
  story_id text primary key references public.gtm_stories(id) on delete cascade,
  text_asset_id text not null references public.gtm_story_assets(id),
  video_asset_id text not null references public.gtm_story_assets(id),
  channels text[] not null check (cardinality(channels) between 1 and 3 and channels <@ array['linkedin','instagram','youtube']::text[]),
  dispatch_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (text_asset_id <> video_asset_id)
);
create index gtm_piece_reviews_text_idx on public.gtm_piece_reviews(text_asset_id);
create index gtm_piece_reviews_video_idx on public.gtm_piece_reviews(video_asset_id);

create table public.gtm_piece_part_decisions (
  story_id text not null references public.gtm_piece_reviews(story_id) on delete cascade,
  part text not null check (part in ('text','video')),
  fingerprint text not null,
  status text not null default 'pending' check (status in ('pending','approved','changes','fixing')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  primary key(story_id,part)
);
create table public.gtm_piece_fixes (
  id uuid primary key default gen_random_uuid(),
  story_id text not null references public.gtm_piece_reviews(story_id) on delete cascade,
  part text not null check (part in ('text','video')),
  -- A fix never pins an asset: removing the asset removes the fix (base_asset keeps the evidence).
  asset_id text not null references public.gtm_story_assets(id) on delete cascade,
  feedback_id uuid references public.gtm_story_feedback(id) on delete set null,
  note text not null check (length(btrim(note)) between 1 and 5000),
  base_fingerprint text not null,
  base_revision bigint not null,
  base_asset jsonb not null,
  authorised_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'open' check(status in ('open','completed','cancelled')),
  completed_fingerprint text,
  completed_revision bigint,
  completed_at timestamptz,
  completed_by text,
  verification text,
  check (status <> 'completed' or (completed_fingerprint is not null and completed_revision is not null and completed_at is not null and length(btrim(completed_by)) > 0 and length(btrim(verification)) > 0))
);
create unique index gtm_piece_one_open_fix on public.gtm_piece_fixes(story_id,part) where status='open';
create index gtm_piece_fixes_feedback_idx on public.gtm_piece_fixes(feedback_id);
create index gtm_piece_fixes_asset_idx on public.gtm_piece_fixes(asset_id);
create index gtm_piece_fixes_author_idx on public.gtm_piece_fixes(authorised_by);
create index gtm_piece_decisions_author_idx on public.gtm_piece_part_decisions(decided_by);

create function public.gtm_piece_require_actor(p_owner_only boolean default false)
returns void language plpgsql set search_path='' as $$
begin
  if not ((select auth.uid()) is not null and coalesce((select auth.jwt())->'app_metadata'->>'gtm_owner' = 'true',false))
     and (p_owner_only or coalesce((select auth.jwt())->>'role','') <> 'service_role') then
    raise exception 'only the cockpit owner may decide content; service access is required for staging' using errcode='42501';
  end if;
end $$;
revoke all on function public.gtm_piece_require_actor(boolean) from public,anon,authenticated;

-- Only publish-affecting values belong in this fingerprint. Display titles, local paths, posters,
-- metadata timestamps and identical re-uploads do not silently invalidate an approval.
create function public.gtm_piece_asset_fingerprint(a public.gtm_story_assets)
returns text language sql immutable set search_path='' as $$
  select encode(extensions.digest(jsonb_build_array(a.kind,a.sha256,a.body,a.url,a.metadata->>'thumbnail_sha256')::text,'sha256'),'hex')
$$;
revoke all on function public.gtm_piece_asset_fingerprint(public.gtm_story_assets) from public,anon,authenticated;

create function public.gtm_piece_snapshot(p_story_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.gtm_piece_reviews; t public.gtm_story_assets; v public.gtm_story_assets;
  td public.gtm_piece_part_decisions; vd public.gtm_piece_part_decisions;
  s public.gtm_stories; blockers text[] := '{}'; ts text; vs text; third_ok boolean;
begin
  perform public.gtm_piece_require_actor();
  select * into p from public.gtm_piece_reviews where story_id=p_story_id;
  if not found then return null; end if;
  select * into t from public.gtm_story_assets where id=p.text_asset_id;
  select * into v from public.gtm_story_assets where id=p.video_asset_id;
  select * into s from public.gtm_stories where id=p_story_id;
  select * into td from public.gtm_piece_part_decisions where story_id=p_story_id and part='text';
  select * into vd from public.gtm_piece_part_decisions where story_id=p_story_id and part='video';
  ts := case when td.status='fixing' then 'fixing' when td.fingerprint=public.gtm_piece_asset_fingerprint(t) then td.status else 'pending' end;
  vs := case when vd.status='fixing' then 'fixing' when vd.fingerprint=public.gtm_piece_asset_fingerprint(v) then vd.status else 'pending' end;
  if coalesce(ts,'pending') <> 'approved' then blockers:=array_append(blockers,case when ts='fixing' then 'Text: waiting for fix' when ts='changes' then 'Text: changes requested' else 'Text: needs approval' end); end if;
  if coalesce(vs,'pending') <> 'approved' then blockers:=array_append(blockers,case when vs='fixing' then 'Video: waiting for fix' when vs='changes' then 'Video: changes requested' else 'Video: needs approval' end); end if;
  if t.story_id is distinct from p_story_id or t.kind is distinct from 'copy' or v.story_id is distinct from p_story_id or v.kind is distinct from 'video' then blockers:=array_append(blockers,'The selected assets are invalid'); end if;
  if coalesce(v.stage,'final') <> 'final' then blockers:=array_append(blockers,'The video is not final'); end if;
  if t.body ~ '(?m)^--- channel: [a-z]+ ---$' then blockers:=array_append(blockers,'Save one shared caption to remove platform-specific variants'); end if;
  if t.body is null or btrim(t.body)='' then blockers:=array_append(blockers,'The text is empty'); end if;
  if v.storage_path is null then blockers:=array_append(blockers,'The video has not been uploaded'); end if;
  if s.held_at is not null then blockers:=array_append(blockers,'Publishing is on hold'); end if;
  if s.third_party_who is not null and btrim(s.third_party_who) <> '' then
    select exists(select 1 from public.gtm_story_stage_decisions d where d.story_id=p_story_id and d.stage='final' and d.party='third_party' and d.decision='approved'
      and btrim(coalesce(d.who,''))=btrim(s.third_party_who)
      and d.assets @> jsonb_build_array(jsonb_build_object('asset_id',v.id,'sha256',v.sha256))
      and not exists(select 1 from public.gtm_story_stage_decisions newer where newer.story_id=d.story_id and newer.stage='final' and newer.party='third_party' and newer.decision in ('changes','reopened') and newer.decided_at>=d.decided_at)) into third_ok;
    if not third_ok then blockers:=array_append(blockers,'Waiting for third-party approval'); end if;
  end if;
  if exists(select 1 from public.gtm_story_feedback f join public.gtm_story_assets a on a.id=f.asset_id where a.story_id=p_story_id and f.resolved_at is null and f.body like '[approved with note:%') then blockers:=array_append(blockers,'Existing accepted notes need conversion before scheduling'); end if;
  if not p.dispatch_enabled then blockers:=array_append(blockers,'Scheduling is paused for this piece'); end if;
  return jsonb_build_object('storyId',p_story_id,'channels',p.channels,'dispatchEnabled',p.dispatch_enabled,
    'text',jsonb_build_object('asset',to_jsonb(t),'fingerprint',public.gtm_piece_asset_fingerprint(t),'status',coalesce(ts,'pending'),'decidedAt',td.decided_at),
    'video',jsonb_build_object('asset',to_jsonb(v),'fingerprint',public.gtm_piece_asset_fingerprint(v),'status',coalesce(vs,'pending'),'decidedAt',vd.decided_at),
    'fixes',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at) from public.gtm_piece_fixes f where f.story_id=p_story_id and f.status='open'),'[]'::jsonb),
    'legacyFixes',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'asset_id',f.asset_id,'body',f.body,'revision',f.revision) order by f.created_at) from public.gtm_story_feedback f join public.gtm_story_assets a on a.id=f.asset_id where a.story_id=p_story_id and f.resolved_at is null and f.body like '[approved with note:%'),'[]'::jsonb),
    'blockers',to_jsonb(blockers),'ready',cardinality(blockers)=0);
end $$;
revoke all on function public.gtm_piece_snapshot(text) from public,anon;
grant execute on function public.gtm_piece_snapshot(text) to authenticated,service_role;

-- Canonical selection is explicit. Historical approval is carried only from real current-byte owner
-- decisions, never a presentation label. Imported pieces stay paused, even when both approvals carry.
create function public.gtm_configure_piece_review(p_story_id text,p_text_asset_id text,p_video_asset_id text,p_channels text[],p_expected jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.gtm_story_assets; v public.gtm_story_assets; a public.gtm_story_assets;
  role_name text; prior public.gtm_piece_reviews; keep boolean; reviewer uuid; at_time timestamptz;
begin
  perform public.gtm_piece_require_actor();
  perform 1 from public.gtm_stories where id=p_story_id for update;
  if not found then raise exception 'piece not found' using errcode='22023'; end if;
  select * into prior from public.gtm_piece_reviews where story_id=p_story_id;
  select * into t from public.gtm_story_assets where id=p_text_asset_id and story_id=p_story_id and kind='copy' for update;
  if not found then raise exception 'select one text belonging to this piece' using errcode='22023'; end if;
  select * into v from public.gtm_story_assets where id=p_video_asset_id and story_id=p_story_id and kind='video' for update;
  if not found then raise exception 'select one video belonging to this piece' using errcode='22023'; end if;
  if p_expected is null or p_expected->>'text' is distinct from public.gtm_piece_asset_fingerprint(t) or p_expected->>'video' is distinct from public.gtm_piece_asset_fingerprint(v) then
    raise exception 'the content changed; reload before selecting it' using errcode='PT409'; end if;
  if cardinality(p_channels) is null or cardinality(p_channels)<1 or cardinality(p_channels)>3 or not(p_channels <@ array['linkedin','instagram','youtube']::text[]) or array_position(p_channels,null) is not null or cardinality(p_channels)<>(select count(distinct c) from unnest(p_channels)c) then
    raise exception 'choose one or more supported channels' using errcode='22023'; end if;
  -- A service may create a pending new workflow, but cannot silently migrate owner-reviewed work or reselect assets.
  if coalesce((select auth.jwt())->>'role','')='service_role' and not coalesce((select auth.jwt())->'app_metadata'->>'gtm_owner'='true',false) then
    if prior.story_id is not null or exists(select 1 from public.gtm_story_asset_channels c join public.gtm_story_assets sa on sa.id=c.asset_id where sa.story_id=p_story_id and c.reviewed_at is not null) then
      raise exception 'an existing reviewed piece requires owner selection' using errcode='42501'; end if;
  end if;
  insert into public.gtm_piece_reviews(story_id,text_asset_id,video_asset_id,channels) values(p_story_id,t.id,v.id,p_channels)
    on conflict(story_id) do update set text_asset_id=excluded.text_asset_id,video_asset_id=excluded.video_asset_id,channels=excluded.channels,updated_at=now();
  foreach role_name in array array['text','video'] loop
    a := case role_name when 'text' then t else v end;
    if prior.story_id is not null and (case role_name when 'text' then prior.text_asset_id else prior.video_asset_id end)=a.id then continue; end if;
    keep := exists(select 1 from public.gtm_story_asset_channels c where c.asset_id=a.id and c.status='approved' and c.approved_sha256=a.sha256 and c.reviewed_by is not null)
      and not exists(select 1 from public.gtm_story_asset_channels c where c.asset_id=a.id and c.status='rejected')
      and not exists(select 1 from public.gtm_story_feedback f where f.resolved_at is null and f.asset_id in (select aa.id from public.gtm_story_assets aa where aa.story_id=p_story_id) and f.body like '[approved with note:%');
    select c.reviewed_by,c.reviewed_at into reviewer,at_time from public.gtm_story_asset_channels c where c.asset_id=a.id and c.status='approved' and c.approved_sha256=a.sha256 order by c.reviewed_at desc limit 1;
    update public.gtm_story_feedback set resolved_at=now(),resolution='Canonical selection superseded this authorisation' where resolved_at is null and id in (select feedback_id from public.gtm_piece_fixes where story_id=p_story_id and part=role_name and status='open');
    update public.gtm_piece_fixes set status='cancelled' where story_id=p_story_id and part=role_name and status='open';
    insert into public.gtm_piece_part_decisions(story_id,part,fingerprint,status,decided_by,decided_at)
      values(p_story_id,role_name,public.gtm_piece_asset_fingerprint(a),case when keep then 'approved' else 'pending' end,case when keep then reviewer end,case when keep then at_time end)
      on conflict(story_id,part) do update set fingerprint=excluded.fingerprint,status=excluded.status,decided_by=excluded.decided_by,decided_at=excluded.decided_at;
  end loop;
  update public.gtm_story_assets set metadata=(metadata-'shared_review_part')||jsonb_build_object('shared_review',true)||case id when p_text_asset_id then jsonb_build_object('shared_review_part','text') when p_video_asset_id then jsonb_build_object('shared_review_part','video') else '{}'::jsonb end where story_id=p_story_id;
  return public.gtm_piece_snapshot(p_story_id);
end $$;
revoke all on function public.gtm_configure_piece_review(text,text,text,text[],jsonb) from public,anon;
grant execute on function public.gtm_configure_piece_review(text,text,text,text[],jsonb) to authenticated,service_role;

create function public.gtm_decide_piece_part(p_story_id text,p_part text,p_decision text,p_note text,p_expected_fingerprint text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.gtm_piece_reviews; a public.gtm_story_assets; fp text; feedback uuid;
begin
  perform public.gtm_piece_require_actor(true);
  if p_part is null or p_decision is null or p_part not in ('text','video') or p_decision not in ('pending','approved','changes','fixing') or p_note is null or length(p_note)>5000 or (p_decision in ('changes','fixing') and btrim(p_note)='') then raise exception 'invalid decision or note' using errcode='22023'; end if;
  perform 1 from public.gtm_stories where id=p_story_id for update;
  select * into p from public.gtm_piece_reviews where story_id=p_story_id for update;
  if not found then raise exception 'shared piece not found' using errcode='22023'; end if;
  select * into a from public.gtm_story_assets where id=case p_part when 'text' then p.text_asset_id else p.video_asset_id end for update;
  fp:=public.gtm_piece_asset_fingerprint(a);
  if p_expected_fingerprint is distinct from fp or p_expected_revision is distinct from a.revision then raise exception 'this version changed; reload before deciding' using errcode='PT409'; end if;
  if a.story_id is distinct from p_story_id or a.kind is distinct from (case p_part when 'text' then 'copy' else 'video' end) then raise exception 'invalid shared asset' using errcode='22023'; end if;
  if p_decision in ('approved','fixing') and p_part='video' and coalesce(a.stage,'final')<>'final' then raise exception 'only the final video can be approved' using errcode='22023'; end if;
  if p_decision in ('approved','fixing') and a.kind='copy' and a.body ~ '(?m)^--- channel: [a-z]+ ---$' then raise exception 'use one shared caption, without platform-specific variants' using errcode='22023'; end if;
  if p_decision in ('approved','fixing') and (a.kind='copy' and (a.body is null or btrim(a.body)='' or a.body ~* '\[(JOHN|TODO|NOTE|REVIEWER|AGENT|CLAUDE|TBD|FIXME|PLACEHOLDER)\y[^]]*\]')) then raise exception 'complete the text before approving' using errcode='22023'; end if;
  update public.gtm_story_feedback set resolved_at=now(),resolution='Owner decision superseded this authorisation' where resolved_at is null and id in (select feedback_id from public.gtm_piece_fixes where story_id=p_story_id and part=p_part and status='open');
  update public.gtm_piece_fixes set status='cancelled' where story_id=p_story_id and part=p_part and status='open';
  if p_decision in ('changes','fixing') then
    insert into public.gtm_story_feedback(asset_id,channel,body,revision,author) values(a.id,null,p_note,a.revision,'john') returning id into feedback;
  end if;
  insert into public.gtm_piece_part_decisions(story_id,part,fingerprint,status,decided_by,decided_at) values(p_story_id,p_part,fp,p_decision,(select auth.uid()),now())
    on conflict(story_id,part) do update set fingerprint=excluded.fingerprint,status=excluded.status,decided_by=excluded.decided_by,decided_at=excluded.decided_at;
  if p_decision='fixing' then
    insert into public.gtm_piece_fixes(story_id,part,asset_id,feedback_id,note,base_fingerprint,base_revision,base_asset,authorised_by)
      values(p_story_id,p_part,a.id,feedback,p_note,fp,a.revision,to_jsonb(a),(select auth.uid()));
  end if;
  -- A fresh owner decision is intentional release authority; migration by itself never enables dispatch.
  if p_decision in ('approved','fixing') then update public.gtm_piece_reviews set dispatch_enabled=true,updated_at=now() where story_id=p_story_id; end if;
  return public.gtm_piece_snapshot(p_story_id);
end $$;
revoke all on function public.gtm_decide_piece_part(text,text,text,text,text,bigint) from public,anon,service_role;
grant execute on function public.gtm_decide_piece_part(text,text,text,text,text,bigint) to authenticated;

create function public.gtm_complete_piece_fix(p_fix_id uuid,p_expected_fingerprint text,p_expected_revision bigint,p_actor text,p_verification text,p_only_authorised_changes boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.gtm_piece_fixes; p public.gtm_piece_reviews; a public.gtm_story_assets; fp text;
begin
  if coalesce((select auth.jwt())->>'role','') <> 'service_role' then raise exception 'fix completion requires service access' using errcode='42501'; end if;
  if p_only_authorised_changes is distinct from true or p_actor is null or length(btrim(p_actor)) not between 1 and 100 or p_verification is null or length(btrim(p_verification)) not between 1 and 5000 then raise exception 'record the actor, verification and scope of the authorised fix' using errcode='22023'; end if;
  select * into f from public.gtm_piece_fixes where id=p_fix_id;
  if not found then raise exception 'fix not found' using errcode='22023'; end if;
  perform 1 from public.gtm_stories where id=f.story_id for update;
  select * into f from public.gtm_piece_fixes where id=p_fix_id for update;
  select * into p from public.gtm_piece_reviews where story_id=f.story_id;
  if f.status <> 'open' or f.asset_id is distinct from (case f.part when 'text' then p.text_asset_id else p.video_asset_id end) or not exists(select 1 from public.gtm_piece_part_decisions d where d.story_id=f.story_id and d.part=f.part and d.status='fixing') then raise exception 'this fix is no longer authorised' using errcode='PT409'; end if;
  select * into a from public.gtm_story_assets where id=f.asset_id for update;
  fp:=public.gtm_piece_asset_fingerprint(a);
  if p_expected_fingerprint is distinct from fp or p_expected_revision is distinct from a.revision then raise exception 'this version changed; verify the current fix' using errcode='PT409'; end if;
  if a.story_id is distinct from f.story_id or (a.kind='video' and coalesce(a.stage,'final')<>'final') then raise exception 'the fix must be on this piece final' using errcode='22023'; end if;
  if fp=f.base_fingerprint then raise exception 'the specified fix has not changed the content' using errcode='22023'; end if;
  if a.kind='copy' and (a.body is null or btrim(a.body)='' or a.body ~* '\[(JOHN|TODO|NOTE|REVIEWER|AGENT|CLAUDE|TBD|FIXME|PLACEHOLDER)\y[^]]*\]') then raise exception 'the text is incomplete' using errcode='22023'; end if;
  update public.gtm_piece_fixes set status='completed',completed_fingerprint=fp,completed_revision=a.revision,completed_at=now(),completed_by=btrim(p_actor),verification=btrim(p_verification) where id=f.id;
  update public.gtm_piece_part_decisions set fingerprint=fp,status='approved',decided_by=f.authorised_by,decided_at=now() where story_id=f.story_id and part=f.part;
  update public.gtm_story_feedback set resolved_at=now(),resolution=btrim(p_verification) where id=f.feedback_id and resolved_at is null;
  return public.gtm_piece_snapshot(f.story_id);
end $$;
revoke all on function public.gtm_complete_piece_fix(uuid,text,bigint,text,text,boolean) from public,anon,authenticated;
grant execute on function public.gtm_complete_piece_fix(uuid,text,bigint,text,text,boolean) to service_role;

-- Staging changes only the affected part. An authorised fix remains explicitly waiting for completion.
-- A stageless asset is a final (as in the snapshot), so annotating it stage='final' re-pends nothing.
create function public.gtm_piece_asset_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if public.gtm_piece_asset_fingerprint(old) is distinct from public.gtm_piece_asset_fingerprint(new) or coalesce(old.stage,'final') is distinct from coalesce(new.stage,'final') then
    update public.gtm_piece_part_decisions d set status='pending',fingerprint=public.gtm_piece_asset_fingerprint(new),decided_by=null,decided_at=null
    from public.gtm_piece_reviews p where p.story_id=d.story_id and (p.text_asset_id=new.id or p.video_asset_id=new.id)
      and d.part=case when p.text_asset_id=new.id then 'text' else 'video' end and d.status<>'fixing';
  end if;
  return new;
end $$;
revoke all on function public.gtm_piece_asset_changed() from public,anon,authenticated;
create trigger gtm_piece_asset_changed after update on public.gtm_story_assets for each row execute function public.gtm_piece_asset_changed();

-- Legacy channel decisions cease to be an approval authority for the selected text and video only.
-- Covers, images and website/newsletter rows of an adopted piece stay decidable per platform.
create function public.gtm_piece_legacy_decision_guard()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status <> 'pending' and exists(select 1 from public.gtm_piece_reviews p where p.text_asset_id=new.asset_id or p.video_asset_id=new.asset_id) then
    raise exception 'this piece uses shared text and video approvals' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.gtm_piece_legacy_decision_guard() from public,anon,authenticated;
create trigger gtm_piece_legacy_decision_guard before insert or update of status on public.gtm_story_asset_channels for each row execute function public.gtm_piece_legacy_decision_guard();

-- Every write is through a checked RPC or service staging. Browser table access is read-only and owner-only.
do $$ declare t text; begin
  foreach t in array array['gtm_piece_reviews','gtm_piece_part_decisions','gtm_piece_fixes'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('revoke all on public.%I from service_role',t);
    execute format('grant select on public.%I to service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using (coalesce((select auth.jwt())->''app_metadata''->>''gtm_owner''=''true'',false))',t||'_owner_read',t);
  end loop;
end $$;

-- The selection UI and new-piece staging read the same fingerprints used by the mutation guards.
create function public.gtm_piece_candidates(p_story_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.gtm_piece_require_actor();
  return coalesce((select jsonb_agg(jsonb_build_object('asset',to_jsonb(a),'fingerprint',public.gtm_piece_asset_fingerprint(a)) order by a.id)
    from public.gtm_story_assets a where a.story_id=p_story_id and a.kind in ('copy','video')),'[]'::jsonb);
end $$;
revoke all on function public.gtm_piece_candidates(text) from public,anon;
grant execute on function public.gtm_piece_candidates(text) to authenticated,service_role;

create function public.gtm_piece_asset_identity_guard()
returns trigger language plpgsql set search_path='' as $$
begin
  if (new.story_id is distinct from old.story_id or new.kind is distinct from old.kind) and exists(select 1 from public.gtm_piece_reviews p where p.text_asset_id=old.id or p.video_asset_id=old.id) then
    raise exception 'a selected shared asset cannot change its piece or kind' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.gtm_piece_asset_identity_guard() from public,anon,authenticated;
create trigger gtm_piece_asset_identity_guard before update on public.gtm_story_assets for each row execute function public.gtm_piece_asset_identity_guard();

-- John's gates before the final (Approve rough cut / paper edit, /studio storyboards and scenes) keep
-- working on an adopted piece; they never touch the shared decisions. "Send back" (a john 'reopened'
-- decision before the final) withdraws the shared video approval, as it withdraws legacy media
-- approvals, and ends any open video fix authorisation: a fix completed on a later final must not
-- approve bytes John has not seen. The owner's note on the asset stays open as ordinary feedback.
create function public.gtm_piece_stage_reopened()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.party='john' and new.decision='reopened' and new.stage<>'final' and exists(select 1 from public.gtm_piece_reviews p where p.story_id=new.story_id) then
    update public.gtm_piece_fixes set status='cancelled' where story_id=new.story_id and part='video' and status='open';
    update public.gtm_piece_part_decisions set status='pending',decided_by=null,decided_at=null where story_id=new.story_id and part='video' and status<>'pending';
  end if;
  return new;
end $$;
revoke all on function public.gtm_piece_stage_reopened() from public,anon,authenticated;
create trigger gtm_piece_stage_reopened after insert on public.gtm_story_stage_decisions for each row execute function public.gtm_piece_stage_reopened();

-- The selected text and video cannot disappear underneath a shared review. Removing any other asset
-- (a production asset, an orphaned platform caption) works as before; deleting the Story still cascades.
create function public.gtm_piece_asset_delete_guard()
returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select 1 from public.gtm_piece_reviews p where p.text_asset_id=old.id or p.video_asset_id=old.id)
     and exists(select 1 from public.gtm_stories s where s.id=old.story_id) then
    raise exception '% is the selected shared % of %; select another asset or release the shared review first',old.id,case when old.kind='copy' then 'text' else 'video' end,old.story_id using errcode='22023';
  end if;
  return old;
end $$;
revoke all on function public.gtm_piece_asset_delete_guard() from public,anon,authenticated;
create trigger gtm_piece_asset_delete_guard before delete on public.gtm_story_assets for each row execute function public.gtm_piece_asset_delete_guard();

-- Owner edits are one compare-and-swap transaction; queued calendar payloads are intentionally untouched.
create function public.gtm_save_piece_text(p_story_id text,p_body text,p_expected_fingerprint text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.gtm_piece_reviews; a public.gtm_story_assets;
begin
  perform public.gtm_piece_require_actor(true);
  if p_body is null or length(btrim(p_body))=0 or octet_length(p_body)>1048576 then raise exception 'text must contain 1 byte to 1 MiB' using errcode='22023'; end if;
  perform 1 from public.gtm_stories where id=p_story_id for update;
  select * into p from public.gtm_piece_reviews where story_id=p_story_id;
  if not found then raise exception 'shared piece not found' using errcode='22023'; end if;
  select * into a from public.gtm_story_assets where id=p.text_asset_id for update;
  if p_expected_fingerprint is distinct from public.gtm_piece_asset_fingerprint(a) or p_expected_revision is distinct from a.revision then raise exception 'text changed while you were editing; your edit is still here' using errcode='PT409'; end if;
  if a.body is distinct from p_body then
    update public.gtm_story_feedback set resolved_at=now(),resolution='Owner edit superseded this authorisation' where resolved_at is null and id in (select feedback_id from public.gtm_piece_fixes where story_id=p_story_id and part='text' and status='open');
    update public.gtm_piece_fixes set status='cancelled' where story_id=p_story_id and part='text' and status='open';
    update public.gtm_piece_part_decisions set status='pending',decided_by=null,decided_at=null where story_id=p_story_id and part='text';
    update public.gtm_story_assets set body=p_body,sha256=encode(extensions.digest(p_body,'sha256'),'hex'),metadata=metadata||jsonb_build_object('edited_in_dashboard',now()) where id=a.id;
  end if;
  return public.gtm_piece_snapshot(p_story_id);
end $$;
revoke all on function public.gtm_save_piece_text(text,text,text,bigint) from public,anon,service_role;
grant execute on function public.gtm_save_piece_text(text,text,text,bigint) to authenticated;

create function public.gtm_convert_piece_legacy_fix(p_story_id text,p_feedback_id uuid,p_part text,p_expected_fingerprint text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.gtm_story_feedback; result jsonb; note_text text;
begin
  perform public.gtm_piece_require_actor(true);
  perform 1 from public.gtm_stories where id=p_story_id for update;
  select f1.* into f from public.gtm_story_feedback f1 join public.gtm_story_assets a on a.id=f1.asset_id where f1.id=p_feedback_id and a.story_id=p_story_id for update of f1;
  if not found or f.resolved_at is not null or f.body not like '[approved with note:%' then raise exception 'legacy note changed; reload before converting' using errcode='PT409'; end if;
  note_text:=btrim(substr(f.body,strpos(f.body,chr(10))+1));
  if strpos(f.body,chr(10))=0 or note_text='' then raise exception 'this legacy note needs an explicit new owner decision' using errcode='22023'; end if;
  result:=public.gtm_decide_piece_part(p_story_id,p_part,'fixing',note_text,p_expected_fingerprint,p_expected_revision);
  update public.gtm_story_feedback set resolved_at=now(),resolution='Owner converted this legacy note to shared authorisation' where id=f.id;
  return public.gtm_piece_snapshot(p_story_id);
end $$;
revoke all on function public.gtm_convert_piece_legacy_fix(text,uuid,text,text,bigint) from public,anon,service_role;
grant execute on function public.gtm_convert_piece_legacy_fix(text,uuid,text,text,bigint) to authenticated;

-- Operational release of an imported piece whose approvals carried, or a pause, without a new content
-- decision. Enabling must name the versions John is looking at; pausing is always allowed.
create function public.gtm_set_piece_dispatch(p_story_id text,p_expected jsonb,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb;
begin
  perform public.gtm_piece_require_actor(true);
  if p_enabled is null then raise exception 'choose scheduling enabled or paused' using errcode='22023'; end if;
  perform 1 from public.gtm_stories where id=p_story_id for update;
  perform 1 from public.gtm_piece_reviews where story_id=p_story_id for update;
  if not found then raise exception 'shared piece not found' using errcode='22023'; end if;
  s:=public.gtm_piece_snapshot(p_story_id);
  if p_enabled and (p_expected is null or s->'text'->>'fingerprint' is distinct from p_expected->>'text' or s->'video'->>'fingerprint' is distinct from p_expected->>'video') then
    raise exception 'piece changed; reload before releasing scheduling' using errcode='PT409'; end if;
  update public.gtm_piece_reviews set dispatch_enabled=p_enabled,updated_at=now() where story_id=p_story_id;
  return public.gtm_piece_snapshot(p_story_id);
end $$;
revoke all on function public.gtm_set_piece_dispatch(text,jsonb,boolean) from public,anon,service_role;
grant execute on function public.gtm_set_piece_dispatch(text,jsonb,boolean) to authenticated;

-- Adoption is not a one-way door. The owner returns a piece to per-platform review: the shared
-- selection, decisions and open fix authorisations go; owner notes stay open on their assets. A legacy
-- platform approval survives only where the shared decision still approves those exact bytes, so a
-- release never resurrects an approval John withdrew while the piece was shared.
create function public.gtm_release_piece_review(p_story_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.gtm_piece_reviews; t public.gtm_story_assets; v public.gtm_story_assets; text_ok boolean; video_ok boolean;
begin
  perform public.gtm_piece_require_actor(true);
  perform 1 from public.gtm_stories where id=p_story_id for update;
  select * into p from public.gtm_piece_reviews where story_id=p_story_id for update;
  if not found then raise exception 'shared piece not found' using errcode='22023'; end if;
  select * into t from public.gtm_story_assets where id=p.text_asset_id for update;
  select * into v from public.gtm_story_assets where id=p.video_asset_id for update;
  text_ok:=exists(select 1 from public.gtm_piece_part_decisions d where d.story_id=p_story_id and d.part='text' and d.status='approved' and d.fingerprint=public.gtm_piece_asset_fingerprint(t));
  video_ok:=exists(select 1 from public.gtm_piece_part_decisions d where d.story_id=p_story_id and d.part='video' and d.status='approved' and d.fingerprint=public.gtm_piece_asset_fingerprint(v));
  delete from public.gtm_piece_reviews where story_id=p_story_id;
  update public.gtm_story_asset_channels c set status='pending',note=''
   where c.status<>'pending' and ((c.asset_id=t.id and not text_ok) or (c.asset_id=v.id and not video_ok));
  update public.gtm_story_assets set metadata=metadata-'shared_review'-'shared_review_part'
   where story_id=p_story_id and (metadata ? 'shared_review' or metadata ? 'shared_review_part');
  return jsonb_build_object('storyId',p_story_id,'released',true,'textApprovalKept',text_ok,'videoApprovalKept',video_ok);
end $$;
revoke all on function public.gtm_release_piece_review(text) from public,anon,service_role;
grant execute on function public.gtm_release_piece_review(text) to authenticated;

commit;
