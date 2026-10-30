-- Storyboard Studio: agent notes never block John (2026-10-12). Notes an agent writes ("[agent pre-review]", rule checks
-- such as "hook starts at 5%... John's rule: ...") are for agents: they stay in the table and in `gtm storyboard feedback`,
-- but only notes John (or a third party) wrote can hold his storyboard approval back, and approving with notes turns only
-- his notes into apply-in-render instructions. Applies to every board at once (it is the count in the function).

create or replace function public.gtm_decide_storyboard(
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
      update public.gtm_storyboard_comments set apply_in_render = true
       where storyboard_id = p_storyboard_id and status = 'open' and author <> 'agent' and author <> 'lint';
      if btrim(p_note) <> '' then
        insert into public.gtm_storyboard_comments (storyboard_id, version, anchor, kind, body, author, apply_in_render)
        values (p_storyboard_id, p_version, '{}', 'note', btrim(p_note), 'john', true);
      end if;
    end if;
    -- Only notes John (or a third party) wrote can hold an approval back; agent notes (pre-review, lint, rule checks)
    -- are for agents and never block him.
    select count(*) into open_count from public.gtm_storyboard_comments c
     where c.storyboard_id = p_storyboard_id and c.status = 'open' and not c.apply_in_render and c.author <> 'agent' and c.author <> 'lint';
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
