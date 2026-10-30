-- Third-party review links, round 2 (John, 2026-10-15).
--   1. A link makes up to `max_accounts` logins (default 2: example_approver and his cofounder), not one. Opening the link again
--      before or after creating a login is harmless: only creating an account uses a slot.
--   2. A third party decides on each asset (the video, each platform's listing) with approve, request changes or a note.
--      Decisions are stored in their own table and never become gtm_story_feedback rows, so a third party's note does not
--      enter the agent work queue (John triages it). The Story's third-party sign-off (the "<who> approved the final" row
--      and the hold release) is written when every reviewable asset is approved on its current bytes.
-- Builds on 20261013120000_gtm_reviewer_invites.sql; the old story-level function gtm_reviewer_decide stays for the CLI.

alter table public.gtm_reviewer_invites
  add column max_accounts smallint not null default 2 check (max_accounts between 1 and 5);

create table public.gtm_reviewer_invite_accounts (
  invite_id uuid not null references public.gtm_reviewer_invites (id) on delete cascade,
  user_id uuid not null,
  email text check (length(email) <= 320),
  claimed_at timestamptz not null default now(),
  primary key (invite_id, user_id)
);
create index gtm_reviewer_invite_accounts_user_idx on public.gtm_reviewer_invite_accounts (user_id);
comment on table public.gtm_reviewer_invite_accounts is 'The logins a third-party review link has made (at most gtm_reviewer_invites.max_accounts). Written by gtm_reviewer_claim only.';

insert into public.gtm_reviewer_invite_accounts (invite_id, user_id, email, claimed_at)
  select i.id, i.claimed_by, i.claimed_email, i.claimed_at from public.gtm_reviewer_invites i where i.claimed_by is not null
  on conflict do nothing;

alter table public.gtm_reviewer_invite_accounts enable row level security;
revoke all on public.gtm_reviewer_invite_accounts from anon, authenticated;
grant all on public.gtm_reviewer_invite_accounts to service_role;
grant select on public.gtm_reviewer_invite_accounts to authenticated;
create policy gtm_reviewer_invite_accounts_owner_read on public.gtm_reviewer_invite_accounts for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- The parties the signed-in caller reviews for: every unrevoked invite one of their accounts belongs to.
create or replace function public.gtm_reviewer_parties()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct i.party order by i.party), '{}')
    from public.gtm_reviewer_invites i
   where (select auth.uid()) is not null and i.revoked_at is null
     and exists (select 1 from public.gtm_reviewer_invite_accounts a where a.invite_id = i.id and a.user_id = (select auth.uid()));
$$;

-- Adds the signed-in caller as one of the invite's logins. Returns the party. Re-claiming one's own invite is a no-op;
-- an unknown, revoked or expired link, or one whose logins are all taken, is refused with one message, so the link
-- reveals nothing. The owner and team members never claim one (John opening the link never uses a slot).
create or replace function public.gtm_reviewer_claim(p_token_sha256 text, p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare inv record; meta jsonb; taken int;
begin
  if (select auth.uid()) is null then
    raise exception 'sign in to accept a review link' using errcode = 'insufficient_privilege';
  end if;
  meta := (select auth.jwt()) -> 'app_metadata';
  if coalesce((meta ->> 'gtm_owner')::boolean, false) or coalesce((meta ->> 'gtm_team')::boolean, false) then
    raise exception 'cockpit accounts do not claim review links' using errcode = 'insufficient_privilege';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' or length(coalesce(p_email, '')) > 320 then
    raise exception 'this review link is not valid' using errcode = 'invalid_parameter_value';
  end if;
  select * into inv from public.gtm_reviewer_invites i where i.token_sha256 = p_token_sha256 for update;
  if inv.id is not null and inv.revoked_at is null
     and exists (select 1 from public.gtm_reviewer_invite_accounts a where a.invite_id = inv.id and a.user_id = (select auth.uid())) then
    return inv.party;
  end if;
  if inv.id is null or inv.revoked_at is not null or inv.expires_at <= now() then
    raise exception 'this review link is not valid' using errcode = 'invalid_parameter_value';
  end if;
  select count(*) into taken from public.gtm_reviewer_invite_accounts a where a.invite_id = inv.id;
  if taken >= inv.max_accounts then
    raise exception 'this review link is not valid' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.gtm_reviewer_invite_accounts (invite_id, user_id, email)
    values (inv.id, (select auth.uid()), nullif(btrim(lower(coalesce(p_email, ''))), ''));
  update public.gtm_reviewer_invites
     set claimed_by = coalesce(claimed_by, (select auth.uid())),
         claimed_email = coalesce(claimed_email, nullif(btrim(lower(coalesce(p_email, ''))), '')),
         claimed_at = coalesce(claimed_at, now())
   where id = inv.id;
  return inv.party;
end $$;

-- Per-asset decisions by a third party. 'note' changes nothing; 'approved' and 'changes' are the decision on exactly
-- the bytes they saw (sha256 + revision).
create table public.gtm_reviewer_asset_decisions (
  id uuid primary key default gen_random_uuid(),
  story_id text not null references public.gtm_stories (id) on delete cascade,
  asset_id text not null references public.gtm_story_assets (id) on delete cascade,
  asset_sha256 text not null check (asset_sha256 ~ '^[0-9a-f]{64}$'),
  revision int not null,
  party text not null check (length(btrim(party)) between 1 and 200),
  decision text not null check (decision in ('approved', 'changes', 'note')),
  note text not null default '' check (length(note) <= 5000),
  decided_by uuid,
  decided_by_email text check (length(decided_by_email) <= 320),
  decided_at timestamptz not null default now(),
  constraint gtm_reviewer_asset_decisions_note check (decision = 'approved' or btrim(note) <> '')
);
create index gtm_reviewer_asset_decisions_asset_idx on public.gtm_reviewer_asset_decisions (asset_id, decided_at);
create index gtm_reviewer_asset_decisions_story_idx on public.gtm_reviewer_asset_decisions (story_id, decided_at);
comment on table public.gtm_reviewer_asset_decisions is 'A third party''s approve / request changes / note on one asset, bound to its bytes. Not gtm_story_feedback: it never enters the agent work queue.';

alter table public.gtm_reviewer_asset_decisions enable row level security;
revoke all on public.gtm_reviewer_asset_decisions from anon, authenticated;
grant all on public.gtm_reviewer_asset_decisions to service_role;
grant select on public.gtm_reviewer_asset_decisions to authenticated;
create policy gtm_reviewer_asset_decisions_owner_read on public.gtm_reviewer_asset_decisions for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- The assets a third party signs off on: video and images bound to a platform, and a platform's copy (its listing).
create function public.gtm_reviewer_decide_asset(p_asset_id text, p_decision text, p_note text, p_sha256 text, p_revision int)
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
    -- Sign-off for the Story once every reviewable asset's latest decision is an approval of its current bytes.
    select count(*) into open_count from public.gtm_story_assets m
     where m.story_id = a.story_id and m.kind in ('video', 'image', 'copy')
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

-- The hourly cap (30 writes per party) now counts asset decisions too.
create or replace function public.gtm_reviewer_throttle(p_who text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select count(*) from public.gtm_story_feedback f where f.author = 'third_party:' || left(p_who, 100) and f.created_at > now() - interval '1 hour')
     + (select count(*) from public.gtm_story_stage_decisions d where d.party = 'third_party' and d.who = p_who and d.decided_at > now() - interval '1 hour')
     + (select count(*) from public.gtm_reviewer_asset_decisions a where a.party = p_who and a.decided_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many notes in the last hour; try again later' using errcode = 'P0429';
  end if;
end $$;
