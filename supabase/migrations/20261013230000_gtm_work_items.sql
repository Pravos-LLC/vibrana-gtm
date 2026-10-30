-- The work board (/work in the GTM cockpit). John's notes land in gtm_story_feedback (/content) and
-- gtm_storyboard_comments (/studio); nothing in the web app runs an agent. A terminal session on John's Mac polls those
-- tables and dispatches agents, and until now John could not see any step between his note and the restage
-- (John, 2026-10-13: "I don't know when my comments trigger agent runs or not").
--
-- One row per job an agent picked up: the notes it covers, a short title, where it is (queued, working, rendering,
-- checking, staged, done, blocked), which agent has it, a rough ETA and one plain line of progress. Agents and the
-- dispatcher write it with the gtm CLI (`gtm work add|update|done`); `gtm story stage` and `gtm story resolve` (and the
-- storyboard equivalents) advance it. A John note no row covers after five minutes shows on the board as
-- "Waiting for an agent" (gtm_work_waiting_notes below).
--
-- Like every gtm_* table: RLS on, the owner reads, only the service role writes.

create table public.gtm_work_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  story_id text references public.gtm_stories (id) on delete set null,
  -- The asset the notes are on (a gtm_story_assets id) when the job is one part of a piece; free text, so a job outlives
  -- a restage that renames an asset.
  asset_id text check (asset_id is null or length(asset_id) between 1 and 200),
  storyboard_id text references public.gtm_storyboards (id) on delete set null,
  -- gtm_story_feedback ids and/or gtm_storyboard_comments ids (both uuid).
  source_note_ids uuid[] not null default '{}',
  title text not null check (length(btrim(title)) between 1 and 200),
  status text not null default 'queued'
    check (status in ('queued', 'working', 'rendering', 'checking', 'staged', 'done', 'blocked')),
  agent text not null default 'agent' check (length(btrim(agent)) between 1 and 80),
  eta_at timestamptz,
  last_update text not null default '' check (length(last_update) <= 300),
  blocked_reason text not null default '' check (length(blocked_reason) <= 1000),
  staged_at timestamptz,
  done_at timestamptz,
  constraint gtm_work_items_blocked_has_reason check (status <> 'blocked' or length(btrim(blocked_reason)) > 0)
);
create index gtm_work_items_status_idx on public.gtm_work_items (status, updated_at desc);
create index gtm_work_items_story_idx on public.gtm_work_items (story_id);
create index gtm_work_items_storyboard_idx on public.gtm_work_items (storyboard_id);
create index gtm_work_items_notes_idx on public.gtm_work_items using gin (source_note_ids);

-- Timestamps follow the status, whoever writes it: updated_at on every change, staged_at when it is staged, done_at when
-- it is done (and the ETA goes, since nothing is left to wait for). Leaving "blocked" clears the reason.
create function public.gtm_work_items_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status = 'staged' and (tg_op = 'INSERT' or old.status is distinct from 'staged') then new.staged_at := now(); end if;
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status is distinct from 'done' then new.done_at := now(); end if;
    new.eta_at := null;
  elsif tg_op = 'UPDATE' and old.status = 'done' then
    new.done_at := null;
  end if;
  if new.status <> 'blocked' and tg_op = 'UPDATE' and old.status = 'blocked' then new.blocked_reason := ''; end if;
  return new;
end $$;
revoke all on function public.gtm_work_items_touch() from public, anon, authenticated;
create trigger gtm_work_items_touch before insert or update on public.gtm_work_items
  for each row execute function public.gtm_work_items_touch();

alter table public.gtm_work_items enable row level security;
revoke all on public.gtm_work_items from anon, authenticated;
grant all on public.gtm_work_items to service_role;
grant select on public.gtm_work_items to authenticated;
create policy gtm_work_items_owner_read on public.gtm_work_items for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- John's open notes (and a third party's) that no work item covers yet, older than the grace period. Agent and lint
-- notes are excluded: they are the agents' own. A /studio note counts while it is open; once an agent answers it
-- (addressed) it waits on John, not on an agent. Security invoker: the owner sees exactly what RLS lets them read.
create function public.gtm_work_waiting_notes(p_grace interval default interval '5 minutes')
returns table (source text, note_id uuid, story_id text, asset_id text, storyboard_id text, author text, body text, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select 'content'::text, f.id, a.story_id, f.asset_id, null::text, f.author, f.body, f.created_at
    from public.gtm_story_feedback f
    join public.gtm_story_assets a on a.id = f.asset_id
   where f.resolved_at is null
     and f.author not in ('agent', 'lint')
     and f.created_at <= now() - p_grace
     and not exists (select 1 from public.gtm_work_items w where w.source_note_ids @> array[f.id])
  union all
  select 'studio'::text, c.id, b.story_id, null::text, c.storyboard_id, c.author, c.body, c.created_at
    from public.gtm_storyboard_comments c
    join public.gtm_storyboards b on b.id = c.storyboard_id
   where c.status = 'open'
     and c.author not in ('agent', 'lint')
     and c.created_at <= now() - p_grace
     and not exists (select 1 from public.gtm_work_items w where w.source_note_ids @> array[c.id])
  order by 8
$$;
revoke all on function public.gtm_work_waiting_notes(interval) from public, anon;
grant execute on function public.gtm_work_waiting_notes(interval) to authenticated, service_role;
