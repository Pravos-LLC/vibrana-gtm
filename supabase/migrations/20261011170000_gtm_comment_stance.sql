-- Red flags on the engage queue (VIB-424). Each comment gets a stance (from the same model call that
-- drafts its reply) and a one-line "what they're objecting to", plus cheap signals about who wrote it that
-- the comment already carries (Zernio's follower count and verified flag) or that we derive without
-- copying anything (whether the author is a CRM contact, and whether an ICP one). Posts whose comments
-- cross the backlash threshold get at most one out-of-cycle alert a day, recorded in gtm_red_flag_alerts.
-- Like every gtm_* table: RLS on, the owner can read, only the service role writes.

alter table public.gtm_comments
  add column stance text check (stance in ('supportive', 'question', 'constructive_dissent', 'misread', 'hostile', 'troll_or_bad_faith', 'spam')),
  add column objection text check (length(objection) <= 300),
  add column stance_at timestamptz,
  add column author_followers integer check (author_followers >= 0),
  add column author_verified boolean,
  -- null: not checked; 'none': not in the CRM; 'contact': a CRM person; 'icp': a CRM person with an offer fit.
  add column author_crm text check (author_crm in ('none', 'contact', 'icp'));

create index gtm_comments_stance_idx on public.gtm_comments (commented_at) where stance is not null and not is_own;

create table public.gtm_red_flag_alerts (
  id uuid primary key default gen_random_uuid(),
  -- platform|post id, the same key the engage code groups a post's comments by.
  post_key text not null check (length(btrim(post_key)) between 3 and 600),
  flag text not null check (flag in ('backlash', 'not_landing', 'healthy_debate')),
  sent_at timestamptz not null default now(),
  stats jsonb not null default '{}',
  email_id text
);
create index gtm_red_flag_alerts_post_idx on public.gtm_red_flag_alerts (post_key, sent_at desc);

alter table public.gtm_red_flag_alerts enable row level security;
revoke all on public.gtm_red_flag_alerts from anon, authenticated;
grant all on public.gtm_red_flag_alerts to service_role;
grant select on public.gtm_red_flag_alerts to authenticated;
create policy gtm_red_flag_alerts_owner_read on public.gtm_red_flag_alerts for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));

-- Claims the alert for one post atomically: a transaction-scoped advisory lock on the post key serializes
-- concurrent webhooks, so the cooldown check and the insert cannot interleave (two racing webhooks used to
-- be able to both pass). Returns the new row's id, or null when an alert for this post is inside the
-- cooldown. Service role only; security invoker, so it runs with the caller's (service_role) rights.
create function public.gtm_claim_red_flag_alert(p_post_key text, p_flag text, p_cooldown_hours integer, p_stats jsonb default '{}')
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed uuid;
begin
  if p_cooldown_hours is null or p_cooldown_hours < 1 or p_cooldown_hours > 24 * 30 then
    raise exception 'cooldown must be between 1 hour and 30 days' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gtm_red_flag_alert:' || p_post_key, 0));
  if exists (
    select 1 from public.gtm_red_flag_alerts
    where post_key = p_post_key and sent_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(hours => p_cooldown_hours)
  ) then
    return null;
  end if;
  insert into public.gtm_red_flag_alerts (post_key, flag, sent_at, stats)
  values (p_post_key, p_flag, pg_catalog.clock_timestamp(), coalesce(p_stats, '{}'::jsonb))
  returning id into claimed;
  return claimed;
end
$$;
revoke all on function public.gtm_claim_red_flag_alert(text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gtm_claim_red_flag_alert(text, text, integer, jsonb) to service_role;
