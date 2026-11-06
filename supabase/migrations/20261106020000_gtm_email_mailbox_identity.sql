-- Email outcomes follow-up (VIB-508, after review of the VIB-510 writer). Two changes the cockpit's mailbox writer needs.
--
-- 1. A Gmail message id is unique per mailbox, not per member. Rows written before 20261106010000 have no mailbox; where
--    the member has exactly one connected mailbox it is filled in, otherwise it stays null (null never collides). The
--    partial unique index becomes a plain unique constraint, which an upsert can target, and the member-wide constraint
--    goes: two mailboxes of one member may hold the same id.
--    Deploy order: the cockpit writer tries (mailbox, gmail_message_id) and falls back to the member key while this
--    migration is not applied, so it works on either side of it. The previous writer (member key only) must be replaced
--    first.
-- 2. Disconnecting a mailbox deletes its events (the member withdrew consent; app/team/mailbox/actions.ts). Attempts and
--    reply decisions now go with their event. A decision still cannot be edited or deleted on its own: the append-only
--    trigger lets a delete through only when its event is already gone (the cascade).

update public.gtm_team_mail_events e
  set mailbox = m.address
  from (select member, min(address) as address from public.gtm_team_mailboxes group by member having count(*) = 1) m
  where e.mailbox is null and e.member = m.member;

drop index public.gtm_team_mail_events_mailbox_once;
alter table public.gtm_team_mail_events add constraint gtm_team_mail_events_mailbox_once unique (mailbox, gmail_message_id);
alter table public.gtm_team_mail_events drop constraint gtm_team_mail_events_once;
create index gtm_team_mail_events_member_message_idx on public.gtm_team_mail_events (member, gmail_message_id);

alter table public.gtm_email_attempts drop constraint gtm_email_attempts_event_id_fkey;
alter table public.gtm_email_attempts add constraint gtm_email_attempts_event_id_fkey
  foreign key (event_id) references public.gtm_team_mail_events (id) on delete cascade;
alter table public.gtm_email_reply_labels drop constraint gtm_email_reply_labels_event_id_fkey;
alter table public.gtm_email_reply_labels add constraint gtm_email_reply_labels_event_id_fkey
  foreign key (event_id) references public.gtm_team_mail_events (id) on delete cascade;

-- Covering indexes for the remaining foreign keys (Supabase advisor unindexed_foreign_keys).
create index gtm_email_attempts_delivery_event_idx on public.gtm_email_attempts (delivery_event_id);
create index gtm_email_sync_ops_evidence_event_idx on public.gtm_email_sync_ops (evidence_event_id);
create index gtm_email_sync_ops_label_idx on public.gtm_email_sync_ops (label_id);

create or replace function public.gtm_email_reply_labels_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.superseded_at is null and new.superseded_at is not null
     and (to_jsonb(new) - 'superseded_at') = (to_jsonb(old) - 'superseded_at') then
    return new;
  end if;
  -- The cascade from a deleted event (a disconnected mailbox): the event row is already gone.
  if tg_op = 'DELETE' and old.event_id is not null
     and not exists (select 1 from public.gtm_team_mail_events e where e.id = old.event_id) then
    return old;
  end if;
  raise exception 'reply decisions are append-only: supersede a decision, never edit or delete it' using errcode = 'insufficient_privilege';
end $$;
revoke all on function public.gtm_email_reply_labels_append_only() from public, anon, authenticated;
