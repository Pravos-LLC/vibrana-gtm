-- VIB-399: a stale Story page raised SQLSTATE 40001 (serialization_failure). PostgREST
-- retries 40001, so over the Data API the owner waited for the 60 s gateway timeout and
-- saw "The upstream server is timing out" instead of the refresh message.
-- PT409 is non-retryable and PostgREST maps it to HTTP 409 Conflict. The function is
-- otherwise unchanged from 20260928160000_gtm_story_assets.sql.

create or replace function public.gtm_decide_story_asset(
  p_asset_id text, p_channel text, p_status text, p_note text,
  p_expected_sha256 text, p_expected_revision bigint
) returns void language plpgsql security definer set search_path = '' as $$
declare current_sha256 text; current_revision bigint;
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
  select a.sha256, a.revision into current_sha256, current_revision
    from public.gtm_story_assets a where a.id = p_asset_id for update;
  if current_sha256 is null then raise exception 'Story asset not found'; end if;
  if current_sha256 is distinct from p_expected_sha256 or current_revision is distinct from p_expected_revision then
    raise exception 'Story asset changed; refresh and review the new version' using errcode = 'PT409';
  end if;
  update public.gtm_story_asset_channels
     set status = p_status, note = case when p_status = 'pending' then '' else p_note end
   where asset_id = p_asset_id and channel = p_channel;
  if not found then raise exception 'Story channel assignment not found'; end if;
end $$;
revoke all on function public.gtm_decide_story_asset(text, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.gtm_decide_story_asset(text, text, text, text, text, bigint) to authenticated;
