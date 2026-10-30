-- Storyboard Studio: "approve with notes" (John, 2026-10-12: "sometimes I just want to add some notes but basically say
-- approve it and go next step, I don't want another round of feedback if it's just a minor thing").
-- A note can be an instruction the agent applies in the render (apply_in_render) instead of a blocker for another round:
--   * gtm_decide_storyboard_scene: approving a scene with a note leaves that note as an apply-in-render instruction.
--   * gtm_decide_storyboard(p_with_notes): approving the storyboard turns every open note into an instruction for the
--     render (and an overall note becomes one too); open apply-in-render notes never block an approval.
-- The agent reads them with `gtm storyboard feedback`, marked "approved with notes: apply in render".

alter table public.gtm_storyboard_comments add column apply_in_render boolean not null default false;
comment on column public.gtm_storyboard_comments.apply_in_render is 'John approved with this note: the agent applies it in the render; it never blocks an approval.';

create or replace function public.gtm_decide_storyboard_scene(
  p_storyboard_id text, p_version int, p_scene_id text, p_expected_scene_sha text, p_decision text, p_note text default ''
) returns void language plpgsql security definer set search_path = '' as $$
declare sb record; live_sha text;
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can decide a scene' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'changes', 'cleared') or p_note is null or length(p_note) > 5000
     or (p_decision = 'changes' and btrim(p_note) = '') or p_scene_id is null then
    raise exception 'invalid scene decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.current_version, s.status into sb from public.gtm_storyboards s where s.id = p_storyboard_id for update;
  if sb.id is null then raise exception 'storyboard not found'; end if;
  if sb.current_version is distinct from p_version then
    raise exception 'a newer version (v%) was pushed; refresh', sb.current_version using errcode = 'PT409';
  end if;
  if sb.status = 'approved' then
    raise exception 'this storyboard is approved; reopen it to change a scene' using errcode = 'invalid_parameter_value';
  end if;
  select v.scene_shas ->> p_scene_id into live_sha from public.gtm_storyboard_versions v
   where v.storyboard_id = p_storyboard_id and v.version = p_version;
  if live_sha is null then raise exception 'no scene % in version %', p_scene_id, p_version using errcode = 'invalid_parameter_value'; end if;
  if live_sha is distinct from p_expected_scene_sha then
    raise exception 'scene % changed; refresh and review it', p_scene_id using errcode = 'PT409';
  end if;
  insert into public.gtm_storyboard_scene_decisions (storyboard_id, version, scene_id, scene_sha, decision, note, decided_by)
  values (p_storyboard_id, p_version, p_scene_id, live_sha, p_decision, btrim(p_note), (select auth.uid()));
  if p_decision = 'approved' then
    update public.gtm_storyboard_comments set status = 'resolved', resolved_at = now()
     where storyboard_id = p_storyboard_id and status = 'addressed' and anchor ->> 'scene_id' = p_scene_id;
    if btrim(p_note) <> '' then
      insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author, apply_in_render)
      values (p_storyboard_id, p_version, jsonb_build_object('scene_id', p_scene_id), 'note', btrim(p_note), 'john', true);
    end if;
  elsif p_decision = 'changes' then
    update public.gtm_storyboard_comments set status = 'open', resolved_at = null
     where storyboard_id = p_storyboard_id and status = 'addressed' and anchor ->> 'scene_id' = p_scene_id;
    insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author)
    values (p_storyboard_id, p_version, jsonb_build_object('scene_id', p_scene_id), 'note', btrim(p_note), 'john');
    update public.gtm_storyboards set status = 'changes' where id = p_storyboard_id and status = 'review';
  end if;
  update public.gtm_storyboards set updated_at = now() where id = p_storyboard_id;
end $$;

drop function public.gtm_decide_storyboard(text, int, text, text, text, boolean);
create function public.gtm_decide_storyboard(
  p_storyboard_id text, p_version int, p_doc_sha text, p_decision text, p_note text default '', p_approve_remaining boolean default false,
  p_with_notes boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare sb record; v record; story_pipeline text; open_count int; missing text;
begin
  if not public.gtm_storyboard_is_owner() then
    raise exception 'only the signed-in owner can decide a storyboard' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'changes') or p_note is null or length(p_note) > 5000
     or (p_decision = 'changes' and btrim(p_note) = '') then
    raise exception 'invalid storyboard decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.story_id, s.stage, s.current_version, s.status into sb from public.gtm_storyboards s where s.id = p_storyboard_id for update;
  if sb.id is null then raise exception 'storyboard not found'; end if;
  if sb.current_version is distinct from p_version then
    raise exception 'a newer version (v%) was pushed; refresh', sb.current_version using errcode = 'PT409';
  end if;
  select x.doc_sha, x.scene_shas, x.motion_sha, x.motion_path, x.credit_cap into v
    from public.gtm_storyboard_versions x where x.storyboard_id = p_storyboard_id and x.version = p_version;
  if v.doc_sha is distinct from p_doc_sha then
    raise exception 'the storyboard changed; refresh and review it' using errcode = 'PT409';
  end if;
  if sb.status = 'approved' then
    raise exception 'already approved; reopen it to change the decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.pipeline into story_pipeline from public.gtm_stories s where s.id = sb.story_id for update;
  if story_pipeline is null then raise exception 'the Story has no pipeline' using errcode = 'invalid_parameter_value'; end if;

  if p_decision = 'approved' then
    -- Approve with notes: John's open notes become instructions the agent applies in the render, not another round.
    if p_with_notes then
      update public.gtm_storyboard_comments set apply_in_render = true where storyboard_id = p_storyboard_id and status = 'open';
      if btrim(p_note) <> '' then
        insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author, apply_in_render)
        values (p_storyboard_id, p_version, '{}', 'note', btrim(p_note), 'john', true);
      end if;
    end if;
    select count(*) into open_count from public.gtm_storyboard_comments c
     where c.storyboard_id = p_storyboard_id and c.status = 'open' and not c.apply_in_render;
    if open_count > 0 then
      raise exception '% open note(s) on this storyboard; the agent answers them first, withdraw them, or approve with notes', open_count
        using errcode = 'invalid_parameter_value';
    end if;
    if p_approve_remaining then
      insert into public.gtm_storyboard_scene_decisions (storyboard_id, version, scene_id, scene_sha, decision, note, decided_by)
      select p_storyboard_id, p_version, u, v.scene_shas ->> u, 'approved', 'approved with the storyboard', (select auth.uid())
        from public.gtm_storyboard_unapproved_scenes(p_storyboard_id, p_version) u;
    end if;
    select string_agg(u, ', ') into missing from public.gtm_storyboard_unapproved_scenes(p_storyboard_id, p_version) u;
    if missing is not null then
      raise exception 'scenes not approved yet: %', missing using errcode = 'invalid_parameter_value';
    end if;
    update public.gtm_storyboard_comments set status = 'resolved', resolved_at = now()
     where storyboard_id = p_storyboard_id and status = 'addressed';
    if v.motion_path = 'motion.so' and v.credit_cap is not null then
      insert into public.gtm_storyboard_spend (storyboard_id, version, kind, credits, motion_sha, note)
      values (p_storyboard_id, p_version, 'authorized', v.credit_cap, v.motion_sha, 'one Motion.so create, approved by John in /studio');
    end if;
  else
    insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author)
    values (p_storyboard_id, p_version, '{}', 'note', btrim(p_note), 'john');
  end if;

  update public.gtm_storyboards set status = case when p_decision = 'approved' then 'approved' else 'changes' end, updated_at = now()
   where id = p_storyboard_id;
  insert into public.gtm_story_stages (story_id, stage, status, note, actor, updated_at)
  values (sb.story_id, sb.stage, p_decision, btrim(p_note), 'john', now())
  on conflict (story_id, stage) do update set status = excluded.status, note = excluded.note, actor = 'john', updated_at = now();
  insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
  values (sb.story_id, sb.stage, 'john', null, p_decision, btrim(p_note),
          jsonb_build_array(jsonb_build_object('storyboard_id', p_storyboard_id, 'version', p_version, 'doc_sha', p_doc_sha)),
          (select auth.uid()));
end $$;
revoke all on function public.gtm_decide_storyboard(text, int, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.gtm_decide_storyboard(text, int, text, text, text, boolean, boolean) to authenticated;
