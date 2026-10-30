-- Content stages, phase 2: stage approvals. An approval before the final ("Approve rough cut", "Approve plan") is a
-- stage decision, logged against the exact bytes John looked at; it never touches a platform approval, so it can never
-- schedule. Only the final is approved per platform, and the database now refuses a platform approval on any asset that
-- is not final. A third party (example_approver) signs off on the final only; "Third party approved" is refused until the final is
-- staged, and it is logged against the final's bytes, so a new final version needs their sign-off again.

-- 1. A platform approval is for the final only. Rough cuts and plans are approved as a stage (gtm_decide_story_stage).
create or replace function public.gtm_decide_story_asset(
  p_asset_id text, p_channel text, p_status text, p_note text,
  p_expected_sha256 text, p_expected_revision bigint
) returns void language plpgsql security definer set search_path = '' as $$
declare current_sha256 text; current_revision bigint; current_stage text;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can review Story assets' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('pending', 'approved', 'rejected') or
     p_note is null or length(p_note) > 5000 or
     (p_status = 'rejected' and btrim(p_note) = '') then
    raise exception 'invalid Story decision' using errcode = 'invalid_parameter_value';
  end if;
  select a.sha256, a.revision, a.stage into current_sha256, current_revision, current_stage
    from public.gtm_story_assets a where a.id = p_asset_id for update;
  if current_sha256 is null then raise exception 'Story asset not found'; end if;
  if current_sha256 is distinct from p_expected_sha256 or current_revision is distinct from p_expected_revision then
    raise exception 'Story asset changed; refresh and review the new version' using errcode = 'PT409';
  end if;
  if p_status = 'approved' and current_stage is not null and current_stage <> 'final' then
    raise exception 'this is a % (not the final); approve the stage, not the post', replace(current_stage, '-', ' ')
      using errcode = 'invalid_parameter_value';
  end if;
  update public.gtm_story_asset_channels
     set status = p_status, note = case when p_status = 'pending' then '' else p_note end
   where asset_id = p_asset_id and channel = p_channel;
  if not found then raise exception 'Story channel assignment not found'; end if;
end $$;
revoke all on function public.gtm_decide_story_asset(text, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.gtm_decide_story_asset(text, text, text, text, text, bigint) to authenticated;

-- 2. John's decision on a stage before the final. p_expected lists every asset at that stage as John saw it
-- ([{asset_id, sha256, revision}]); a stale page (a restage since, or an asset it never showed) is refused with 409.
--   approved  -> the stage row is approved. Nothing schedules; the next stage is the agent's.
--   changes   -> the stage row is 'changes' and the note is left on the first asset, tagged with the stage.
--   reopened  -> "Send back to <stage>": p_stage returns to 'changes', p_reset_stages (the stages after it) to 'todo',
--                and every platform approval on the Story's media is withdrawn, so the final cannot schedule meanwhile.
create function public.gtm_decide_story_stage(
  p_story_id text, p_stage text, p_decision text, p_note text, p_expected jsonb, p_reset_stages text[] default '{}'
) returns void language plpgsql security definer set search_path = '' as $$
declare
  story_pipeline text; row_status text; e jsonb; a record; first_asset text; seen text[] := '{}'; unseen text;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can decide a stage' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'changes', 'reopened') or p_stage is null or p_stage !~ '^[a-z][a-z0-9-]{0,39}$'
     or p_stage = 'final' or p_note is null or length(p_note) > 5000
     or (p_decision <> 'approved' and btrim(p_note) = '')
     or p_expected is null or jsonb_typeof(p_expected) <> 'array' or jsonb_array_length(p_expected) = 0
     or exists (select 1 from unnest(coalesce(p_reset_stages, '{}')) r where r !~ '^[a-z][a-z0-9-]{0,39}$' or r = p_stage) then
    raise exception 'invalid stage decision' using errcode = 'invalid_parameter_value';
  end if;
  select s.pipeline into story_pipeline from public.gtm_stories s where s.id = p_story_id for update;
  if not found then raise exception 'Story not found'; end if;
  if story_pipeline is null then raise exception 'this Story has no pipeline; approve it per platform' using errcode = 'invalid_parameter_value'; end if;

  -- Every expected asset is the live one, by bytes and revision.
  for e in select * from jsonb_array_elements(p_expected) loop
    select x.id, x.story_id, x.sha256, x.revision, x.stage into a
      from public.gtm_story_assets x where x.id = e ->> 'asset_id' for update;
    if a.id is null or a.story_id <> p_story_id then raise exception 'Story asset not found'; end if;
    if a.sha256 is distinct from e ->> 'sha256' or a.revision is distinct from (e ->> 'revision')::bigint then
      raise exception 'Story asset changed; refresh and review the new version' using errcode = 'PT409';
    end if;
    if p_decision <> 'reopened' and a.stage is distinct from p_stage then
      raise exception 'that asset is not at stage %; refresh', p_stage using errcode = 'PT409';
    end if;
    seen := seen || a.id;
    first_asset := coalesce(least(first_asset, a.id), a.id);
  end loop;

  if p_decision <> 'reopened' then
    -- John saw every asset at the stage (a restage may have added one since the page loaded).
    select x.id into unseen from public.gtm_story_assets x
     where x.story_id = p_story_id and x.stage = p_stage and not (x.id = any (seen)) limit 1;
    if unseen is not null then
      raise exception 'a new asset was staged at %; refresh and review it', p_stage using errcode = 'PT409';
    end if;
    select st.status into row_status from public.gtm_story_stages st where st.story_id = p_story_id and st.stage = p_stage;
    if row_status is null or row_status not in ('review', 'changes', 'approved') then
      raise exception 'nothing at stage % is waiting for review', p_stage using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into public.gtm_story_stages (story_id, stage, status, note, actor, updated_at)
  values (p_story_id, p_stage, case when p_decision = 'approved' then 'approved' else 'changes' end, btrim(p_note), 'john', now())
  on conflict (story_id, stage) do update set status = excluded.status, note = excluded.note, actor = 'john', updated_at = now();

  if p_decision <> 'approved' then
    insert into public.gtm_story_feedback (asset_id, channel, body, revision, stage)
    select x.id, null, btrim(p_note), x.revision, p_stage from public.gtm_story_assets x where x.id = first_asset;
  end if;

  if p_decision = 'reopened' then
    update public.gtm_story_stages set status = 'todo', note = '', actor = 'john', updated_at = now()
     where story_id = p_story_id and stage = any (coalesce(p_reset_stages, '{}'));
    update public.gtm_story_asset_channels c set status = 'pending', note = ''
      from public.gtm_story_assets x
     where x.id = c.asset_id and x.story_id = p_story_id and x.kind in ('video', 'image') and c.status <> 'pending';
  end if;

  insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
  values (p_story_id, p_stage, 'john', null, p_decision, btrim(p_note), p_expected, (select auth.uid()));
end $$;
revoke all on function public.gtm_decide_story_stage(text, text, text, text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.gtm_decide_story_stage(text, text, text, text, jsonb, text[]) to authenticated;

-- 3. "Third party approved" is a sign-off on the final. It is refused until every platform's media is final (a third
-- party never sees a rough cut), and it is logged against the final's bytes: when a new final is staged, the cockpit
-- reads the third party's gate as open again (vibrana-gtm lib/third-party.ts).
create or replace function public.gtm_set_story_hold(p_story_id text, p_held boolean, p_who text, p_note text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare story record; not_final text; snapshot jsonb;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can hold a Story' using errcode = 'insufficient_privilege';
  end if;
  if p_held is null or length(coalesce(p_who, '')) > 200 or length(coalesce(p_note, '')) > 2000 then
    raise exception 'invalid hold' using errcode = 'invalid_parameter_value';
  end if;
  select s.id, s.held_at, s.hold_who, s.third_party_who into story from public.gtm_stories s where s.id = p_story_id for update;
  if story.id is null then raise exception 'Story not found'; end if;
  if p_held then
    update public.gtm_stories
       set held_at = coalesce(held_at, now()), held_by = (select auth.uid()),
           hold_who = btrim(coalesce(p_who, '')), hold_note = btrim(coalesce(p_note, '')), updated_at = now()
     where id = p_story_id;
    return true;
  end if;
  if story.third_party_who is not null then
    select x.title into not_final from public.gtm_story_assets x
     where x.story_id = p_story_id and x.kind in ('video', 'image') and x.stage is not null and x.stage <> 'final'
       and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = x.id) limit 1;
    if not_final is not null then
      raise exception '% sees the final only, and % is not final yet', story.third_party_who, not_final
        using errcode = 'invalid_parameter_value';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('asset_id', x.id, 'sha256', x.sha256, 'revision', x.revision) order by x.id), '[]')
      into snapshot from public.gtm_story_assets x
     where x.story_id = p_story_id and x.kind in ('video', 'image')
       and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = x.id);
    insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
    values (p_story_id, 'final', 'third_party', coalesce(nullif(story.hold_who, ''), story.third_party_who), 'approved',
            btrim(coalesce(p_note, '')), snapshot, (select auth.uid()));
  end if;
  update public.gtm_stories
     set held_at = null, held_by = null, hold_who = null, hold_note = '', updated_at = now()
   where id = p_story_id;
  return false;
end $$;
revoke all on function public.gtm_set_story_hold(text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.gtm_set_story_hold(text, boolean, text, text) to authenticated;

-- 4. Platform approvals already given to a non-final asset (phase 0 allowed it: "the edit is good") become John's stage
-- approval when every platform approved the current bytes, logged against those bytes. Then every platform decision on
-- a non-final asset returns to pending: the stage row now carries "approved" or "changes".
with approved as (
  select x.story_id, x.stage, x.id, x.sha256, x.revision, max(c.reviewed_by::text)::uuid as reviewer
    from public.gtm_story_assets x
    join public.gtm_story_asset_channels c on c.asset_id = x.id
   where x.stage is not null and x.stage <> 'final'
   group by x.story_id, x.stage, x.id, x.sha256, x.revision
  having bool_and(c.status = 'approved' and c.approved_sha256 = x.sha256)
), logged as (
  insert into public.gtm_story_stage_decisions (story_id, stage, party, decision, note, assets, decided_by)
  select story_id, stage, 'john', 'approved', 'approved per platform before stage approvals existed',
         jsonb_agg(jsonb_build_object('asset_id', id, 'sha256', sha256, 'revision', revision) order by id), max(reviewer::text)::uuid
    from approved group by story_id, stage
  returning story_id, stage
)
insert into public.gtm_story_stages (story_id, stage, status, note, actor)
select story_id, stage, 'approved', '', 'john' from logged
on conflict (story_id, stage) do update set status = 'approved', actor = 'john', updated_at = now();

update public.gtm_story_asset_channels c set status = 'pending', note = ''
  from public.gtm_story_assets x
 where x.id = c.asset_id and x.stage is not null and x.stage <> 'final' and c.status <> 'pending';
