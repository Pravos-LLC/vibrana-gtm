-- Feedback on Story assets, separate from approval. A note no longer has to mean "needs a change":
-- the owner can approve a caption and still leave a note on the same asset, and whoever works the
-- note (an agent through the service role) resolves it with a reply the owner can read.

create table public.gtm_story_feedback (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references public.gtm_story_assets (id) on delete cascade,
  channel text check (channel is null or channel ~ '^[a-z][a-z0-9_]*$'),
  body text not null check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text not null default '' check (length(resolution) <= 5000),
  constraint gtm_story_feedback_resolution check (resolved_at is not null or resolution = '')
);
create index gtm_story_feedback_asset_idx on public.gtm_story_feedback (asset_id, created_at);
create index gtm_story_feedback_open_idx on public.gtm_story_feedback (asset_id) where resolved_at is null;

alter table public.gtm_story_feedback enable row level security;
revoke all on public.gtm_story_feedback from anon, authenticated;
grant all on public.gtm_story_feedback to service_role;
grant select on public.gtm_story_feedback to authenticated;

-- The existing owner claim is server-set app_metadata, never user_metadata. Like every gtm_* table
-- the owner can only read it directly; adding a note goes through the function below, and only the
-- service role resolves one.
create policy gtm_story_feedback_owner_read on public.gtm_story_feedback for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

create function public.gtm_add_story_feedback(p_asset_id text, p_channel text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if (select auth.uid()) is null or
     not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false) then
    raise exception 'only the signed-in owner can leave Story feedback' using errcode = 'insufficient_privilege';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 5000 then
    raise exception 'invalid Story feedback' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.gtm_story_assets a where a.id = p_asset_id) then
    raise exception 'Story asset not found';
  end if;
  insert into public.gtm_story_feedback (asset_id, channel, body) values (p_asset_id, p_channel, p_body)
    returning id into new_id;
  return new_id;
end $$;
revoke all on function public.gtm_add_story_feedback(text, text, text) from public, anon, authenticated;
grant execute on function public.gtm_add_story_feedback(text, text, text) to authenticated;
