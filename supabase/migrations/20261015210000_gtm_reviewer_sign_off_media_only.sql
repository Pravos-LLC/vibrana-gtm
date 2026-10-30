-- A third party signs off on the media (the video and any image), not on the posts. A platform's copy can still be
-- looked at and commented on, but it no longer holds back the Story's sign-off and the hold release (John, 2026-10-15).
create or replace function public.gtm_reviewer_decide_asset(p_asset_id text, p_decision text, p_note text, p_sha256 text, p_revision int)
returns void language plpgsql security definer set search_path = '' as $$
declare a record; who text; email text; open_count int; snapshot jsonb;
begin
  if p_decision not in ('approved', 'changes', 'note') or p_note is null or length(p_note) > 5000
     or (p_decision <> 'approved' and btrim(p_note) = '')
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_revision is null then
    raise exception 'invalid decision' using errcode = 'invalid_parameter_value';
  end if;
  select x.id, x.story_id, x.title, x.kind, x.sha256, x.revision into a from public.gtm_story_assets x where x.id = p_asset_id;
  if a.id is null or a.kind not in ('video', 'image', 'copy')
     or not exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = a.id) then
    raise exception 'not found' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.gtm_stories s where s.id = a.story_id for update;
  who := public.gtm_reviewer_story(a.story_id);
  perform public.gtm_reviewer_throttle(who);
  select x.id, x.story_id, x.title, x.kind, x.sha256, x.revision into a from public.gtm_story_assets x where x.id = p_asset_id for update;
  if a.sha256 is distinct from p_sha256 or a.revision is distinct from p_revision then
    raise exception 'this asset changed; refresh and review the new version' using errcode = 'PT409';
  end if;
  email := nullif(btrim(lower(coalesce((select auth.jwt()) ->> 'email', ''))), '');
  insert into public.gtm_reviewer_asset_decisions (story_id, asset_id, asset_sha256, revision, party, decision, note, decided_by, decided_by_email)
    values (a.story_id, a.id, a.sha256, a.revision, who, p_decision, btrim(p_note), (select auth.uid()), email);

  if p_decision = 'changes' then
    -- Visible to John in /content and `gtm story status` as the third party's request, without creating agent work.
    insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
    select a.story_id, 'final', 'third_party', who, 'changes', left(a.title || ': ' || btrim(p_note), 5000),
           coalesce(jsonb_agg(jsonb_build_object('asset_id', m.id, 'sha256', m.sha256, 'revision', m.revision) order by m.id), '[]'::jsonb), (select auth.uid())
      from public.gtm_story_assets m
     where m.story_id = a.story_id and m.kind in ('video', 'image')
       and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = m.id);
  elsif p_decision = 'approved' then
    -- Sign-off for the Story once every video and image's latest decision is an approval of its current bytes.
    select count(*) into open_count from public.gtm_story_assets m
     where m.story_id = a.story_id and m.kind in ('video', 'image')
       and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = m.id)
       and not exists (
         select 1 from public.gtm_reviewer_asset_decisions d
          where d.asset_id = m.id and d.decision = 'approved' and d.asset_sha256 = m.sha256 and d.revision = m.revision
            and not exists (select 1 from public.gtm_reviewer_asset_decisions d2
                             where d2.asset_id = m.id and d2.decision in ('approved', 'changes') and d2.decided_at > d.decided_at));
    if open_count = 0 then
      select coalesce(jsonb_agg(jsonb_build_object('asset_id', m.id, 'sha256', m.sha256, 'revision', m.revision) order by m.id), '[]'::jsonb) into snapshot
        from public.gtm_story_assets m
       where m.story_id = a.story_id and m.kind in ('video', 'image')
         and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = m.id);
      insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
        values (a.story_id, 'final', 'third_party', who, 'approved', 'approved every asset', snapshot, (select auth.uid()));
      update public.gtm_stories
         set held_at = null, held_by = null, hold_who = null, hold_note = '', updated_at = now()
       where id = a.story_id and held_at is not null and coalesce(nullif(btrim(hold_who), ''), who) = who;
    end if;
  end if;
end $$;
revoke all on function public.gtm_reviewer_decide_asset(text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.gtm_reviewer_decide_asset(text, text, text, text, int) to authenticated;
