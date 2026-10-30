-- Engage: two additions to the comment queue.
--
-- 1. gtm_comments.attachments: what a DM carries besides text (photos, videos, shared posts and reels). They were thrown
--    away at ingest, so the card showed "(attachment)" and John had to open the app to see what his wife sent him. One
--    entry per attachment, in message order: {"type": "image", "mime": "image/jpeg", "name": null, "message_id": "..."}.
--    No URL is kept: Instagram and Facebook sign media links and expire them, so the cockpit asks Zernio for a live link
--    each time it renders one (app/api/engage/attachment in the cockpit).
-- 2. gtm_red_flag_resolutions: John closes a red flag ("the guest already answered, it is fine") with an optional note.
--    A resolved flag leaves the strip, the 07:00 email and the dashboard until a newer comment lands on that post. The
--    note also becomes a classification lesson (gtm_engage_lessons, source john) so later runs are more discerning.
--
-- Additive: the cockpit behaves exactly as before if it lags this migration.
-- Like every gtm_* table: RLS on, the owner reads, only the service role writes.

alter table public.gtm_comments
  add column attachments jsonb check (
    attachments is null or (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10 and length(attachments::text) <= 4000)
  );

create table public.gtm_red_flag_resolutions (
  id uuid primary key default gen_random_uuid(),
  -- platform|post id, the same key the engage code groups a post's comments by.
  post_key text not null check (length(btrim(post_key)) between 3 and 600),
  flag text not null check (flag in ('backlash', 'not_landing', 'healthy_debate')),
  note text check (note is null or length(note) <= 1000),
  resolved_by text check (resolved_by is null or length(resolved_by) <= 200),
  resolved_at timestamptz not null default now(),
  -- The lesson written from the note, when there was one (null: no note, or the lesson was refused).
  lesson_id uuid references public.gtm_engage_lessons (id) on delete set null
);
create index gtm_red_flag_resolutions_post_idx on public.gtm_red_flag_resolutions (post_key, resolved_at desc);

alter table public.gtm_red_flag_resolutions enable row level security;
revoke all on public.gtm_red_flag_resolutions from anon, authenticated;
grant all on public.gtm_red_flag_resolutions to service_role;
grant select on public.gtm_red_flag_resolutions to authenticated;
create policy gtm_red_flag_resolutions_owner_read on public.gtm_red_flag_resolutions for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
