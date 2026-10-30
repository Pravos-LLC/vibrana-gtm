-- Content stages, phase 4: one note for a whole series. "Note for all 5" (for example "the end card sub-line is too
-- small") writes one feedback row per piece with a shared batch_id, so the agent fixes it once, restages all five and
-- resolves them together, and the cockpit can say "Series note resolved" once instead of five times.

alter table public.gtm_story_feedback add column batch_id uuid;
create index gtm_story_feedback_batch_idx on public.gtm_story_feedback (batch_id) where batch_id is not null;

-- Same function with an optional batch id; three-argument calls keep working through the default.
drop function public.gtm_add_story_feedback(text, text, text);
create function public.gtm_add_story_feedback(p_asset_id text, p_channel text, p_body text, p_batch_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid; current_revision bigint; current_stage text;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can leave Story feedback' using errcode = 'insufficient_privilege';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 5000 then
    raise exception 'invalid Story feedback' using errcode = 'invalid_parameter_value';
  end if;
  select a.revision, a.stage into current_revision, current_stage from public.gtm_story_assets a where a.id = p_asset_id;
  if current_revision is null then raise exception 'Story asset not found'; end if;
  insert into public.gtm_story_feedback (asset_id, channel, body, revision, stage, batch_id)
    values (p_asset_id, p_channel, p_body, current_revision, current_stage, p_batch_id)
    returning id into new_id;
  return new_id;
end $$;
revoke all on function public.gtm_add_story_feedback(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.gtm_add_story_feedback(text, text, text, uuid) to authenticated;
