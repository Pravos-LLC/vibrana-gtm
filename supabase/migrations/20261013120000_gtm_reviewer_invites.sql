-- Third-party reviewer links (vibrana-gtm /invite and /shared). A third party who must sign off on a final (example_approver /
-- Example Series) gets a private link John sends over WhatsApp. The link is a single-use invite: the first person to open it
-- picks any email and a password, and the invite binds to that account. From then on the account sees only the pieces
-- whose gtm_stories.third_party_who names the invite's party, and only at the final stage. It can leave notes and
-- approve or request changes; nothing else in the cockpit opens to it.
--
-- The link carries a random token; only its sha256 is stored. Authorization lives here, not in app_metadata: every
-- reviewer function resolves the caller's parties from a claimed, unrevoked invite, so revoking an invite cuts access
-- at once, whatever the JWT still says. The cockpit's own app_metadata flag (gtm_reviewer) only routes pages.

create table public.gtm_reviewer_invites (
  id uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  party text not null check (length(btrim(party)) between 1 and 200 and party = btrim(party)),
  note text not null default '' check (length(note) <= 2000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by text check (length(created_by) <= 200),
  claimed_by uuid,
  claimed_email text check (length(claimed_email) <= 320),
  claimed_at timestamptz,
  revoked_at timestamptz,
  constraint gtm_reviewer_invites_claim check (
    (claimed_by is null and claimed_at is null and claimed_email is null)
    or (claimed_by is not null and claimed_at is not null)
  )
);
create index gtm_reviewer_invites_claimed_idx on public.gtm_reviewer_invites (claimed_by) where claimed_by is not null and revoked_at is null;

comment on table public.gtm_reviewer_invites is 'Single-use third-party reviewer links (vibrana-gtm /invite/<token>). Written by the service role only.';
comment on column public.gtm_reviewer_invites.expires_at is 'Last moment the link can be claimed. A claimed invite stays valid until revoked.';

alter table public.gtm_reviewer_invites enable row level security;
revoke all on public.gtm_reviewer_invites from anon, authenticated;
grant all on public.gtm_reviewer_invites to service_role;
grant select on public.gtm_reviewer_invites to authenticated;
create policy gtm_reviewer_invites_owner_read on public.gtm_reviewer_invites for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- Who wrote a note on a Story asset: John (the default, every existing row), an agent, or a third party.
-- Same vocabulary as gtm_storyboard_comments.author.
alter table public.gtm_story_feedback
  add column author text not null default 'john' check (author ~ '^(john|lint|agent|third_party:.{1,100})$');

-- The parties the signed-in caller reviews for: every claimed, unrevoked invite of theirs. Empty for everyone else.
create function public.gtm_reviewer_parties()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct i.party order by i.party), '{}')
    from public.gtm_reviewer_invites i
   where (select auth.uid()) is not null and i.claimed_by = (select auth.uid()) and i.revoked_at is null;
$$;
revoke all on function public.gtm_reviewer_parties() from public, anon, authenticated;
grant execute on function public.gtm_reviewer_parties() to authenticated, service_role;

-- Binds an invite to the signed-in caller. Returns the party. Re-claiming one's own invite is a no-op; an invite that is
-- claimed by someone else, revoked, expired or unknown is refused with the same message, so the link reveals nothing.
-- The owner and team members never claim one (John opening the link to check it must not use it up).
create function public.gtm_reviewer_claim(p_token_sha256 text, p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare inv record; meta jsonb;
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
  if inv.id is not null and inv.claimed_by = (select auth.uid()) and inv.revoked_at is null then
    return inv.party;
  end if;
  if inv.id is null or inv.claimed_by is not null or inv.revoked_at is not null or inv.expires_at <= now() then
    raise exception 'this review link is not valid' using errcode = 'invalid_parameter_value';
  end if;
  update public.gtm_reviewer_invites
     set claimed_by = (select auth.uid()), claimed_email = nullif(btrim(lower(coalesce(p_email, ''))), ''), claimed_at = now()
   where id = inv.id;
  return inv.party;
end $$;
revoke all on function public.gtm_reviewer_claim(text, text) from public, anon, authenticated;
grant execute on function public.gtm_reviewer_claim(text, text) to authenticated;

-- The Story's media a third party signs off on: video and images bound to at least one platform (as gtm_set_story_hold).
-- Raises unless the caller reviews for the Story's third party and every such asset is final.
create function public.gtm_reviewer_story(p_story_id text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare who text; not_final text;
begin
  select s.third_party_who into who from public.gtm_stories s where s.id = p_story_id;
  if who is null or not (btrim(who) = any (public.gtm_reviewer_parties())) then
    raise exception 'not found' using errcode = 'insufficient_privilege';
  end if;
  select x.title into not_final from public.gtm_story_assets x
   where x.story_id = p_story_id and x.kind in ('video', 'image') and x.stage is not null and x.stage <> 'final'
     and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = x.id) limit 1;
  if not_final is not null then
    raise exception 'this piece is still in production; the final will be shared when it is ready' using errcode = 'invalid_parameter_value';
  end if;
  return btrim(who);
end $$;
revoke all on function public.gtm_reviewer_story(text) from public, anon, authenticated;

-- A review link is an outside account: cap what it can write (and the email John gets for each) at 30 notes and
-- decisions an hour per party.
create function public.gtm_reviewer_throttle(p_who text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select count(*) from public.gtm_story_feedback f where f.author = 'third_party:' || left(p_who, 100) and f.created_at > now() - interval '1 hour')
     + (select count(*) from public.gtm_story_stage_decisions d where d.party = 'third_party' and d.who = p_who and d.decided_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many notes in the last hour; try again later' using errcode = 'P0429';
  end if;
end $$;
revoke all on function public.gtm_reviewer_throttle(text) from public, anon, authenticated;

-- A third party's note on one final asset. It changes no approval; the agent works it like John's notes.
create function public.gtm_reviewer_add_feedback(p_asset_id text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a record; who text; new_id uuid;
begin
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 5000 then
    raise exception 'invalid feedback' using errcode = 'invalid_parameter_value';
  end if;
  select x.id, x.story_id, x.kind, x.revision, x.stage into a from public.gtm_story_assets x where x.id = p_asset_id;
  if a.id is null or a.kind not in ('video', 'image')
     or not exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = a.id) then
    raise exception 'not found' using errcode = 'insufficient_privilege';
  end if;
  who := public.gtm_reviewer_story(a.story_id);
  perform public.gtm_reviewer_throttle(who);
  insert into public.gtm_story_feedback (asset_id, channel, body, revision, stage, author)
    values (a.id, null, btrim(p_body), a.revision, coalesce(a.stage, 'final'), 'third_party:' || left(who, 100))
    returning id into new_id;
  return new_id;
end $$;
revoke all on function public.gtm_reviewer_add_feedback(text, text) from public, anon, authenticated;
grant execute on function public.gtm_reviewer_add_feedback(text, text) to authenticated;

-- The third party's decision on the final, bound to exactly the bytes they watched (p_expected: [{asset_id, sha256,
-- revision}] covering every platform media asset; anything else is a stale page, 409).
--   approved -> logged as the third party's sign-off (the same row "<who> approved the final" writes in /content), and
--               their hold (one naming them, or naming nobody) is released, so whatever John has approved schedules. A
--               hold John set for someone else ("waiting on legal") stays.
--   changes  -> logged, and the note is left on the first asset for the agent. A later approval of a new final clears it.
create function public.gtm_reviewer_decide(p_story_id text, p_decision text, p_note text, p_expected jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare who text; e jsonb; x record; snapshot jsonb; first_asset text; media_count int;
begin
  if p_decision not in ('approved', 'changes') or p_note is null or length(p_note) > 5000
     or (p_decision = 'changes' and btrim(p_note) = '')
     or p_expected is null or jsonb_typeof(p_expected) <> 'array' or jsonb_array_length(p_expected) = 0 then
    raise exception 'invalid decision' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.gtm_stories s where s.id = p_story_id for update;
  who := public.gtm_reviewer_story(p_story_id);
  perform public.gtm_reviewer_throttle(who);

  select count(*) into media_count from public.gtm_story_assets m
   where m.story_id = p_story_id and m.kind in ('video', 'image')
     and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = m.id);
  if media_count = 0 then
    raise exception 'nothing to review yet' using errcode = 'invalid_parameter_value';
  end if;
  if media_count <> jsonb_array_length(p_expected)
     or (select count(distinct v ->> 'asset_id') from jsonb_array_elements(p_expected) v) <> media_count then
    raise exception 'this piece changed; refresh and review the new version' using errcode = 'PT409';
  end if;
  for e in select * from jsonb_array_elements(p_expected) loop
    select m.id, m.sha256, m.revision into x from public.gtm_story_assets m
     where m.id = e ->> 'asset_id' and m.story_id = p_story_id and m.kind in ('video', 'image')
       and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = m.id)
     for update;
    if x.id is null or x.sha256 is distinct from e ->> 'sha256' or x.revision::text is distinct from e ->> 'revision' then
      raise exception 'this piece changed; refresh and review the new version' using errcode = 'PT409';
    end if;
    first_asset := coalesce(least(first_asset, x.id), x.id);
  end loop;

  select jsonb_agg(jsonb_build_object('asset_id', m.id, 'sha256', m.sha256, 'revision', m.revision) order by m.id)
    into snapshot from public.gtm_story_assets m
   where m.story_id = p_story_id and m.kind in ('video', 'image')
     and exists (select 1 from public.gtm_story_asset_channels c where c.asset_id = m.id);

  insert into public.gtm_story_stage_decisions (story_id, stage, party, who, decision, note, assets, decided_by)
  values (p_story_id, 'final', 'third_party', who, p_decision, btrim(p_note), snapshot, (select auth.uid()));

  if p_decision = 'changes' then
    insert into public.gtm_story_feedback (asset_id, channel, body, revision, stage, author)
    select m.id, null, btrim(p_note), m.revision, coalesce(m.stage, 'final'), 'third_party:' || left(who, 100)
      from public.gtm_story_assets m where m.id = first_asset;
  else
    update public.gtm_stories
       set held_at = null, held_by = null, hold_who = null, hold_note = '', updated_at = now()
     where id = p_story_id and held_at is not null and coalesce(nullif(btrim(hold_who), ''), who) = who;
  end if;
end $$;
revoke all on function public.gtm_reviewer_decide(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.gtm_reviewer_decide(text, text, text, jsonb) to authenticated;
