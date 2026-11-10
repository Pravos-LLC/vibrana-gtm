-- Writing desk (VIB-522): replies on the warm streams, marked by hand.
-- 1. linkedin_replied_at: a reply to a LinkedIn note. LinkedIn has no API for messages, so John marks the reply on the desk
--    ("Mark replied") and this column records when. An email reply already has email_status 'replied' and email_replied_at
--    (20261105030000_gtm_pipeline.sql). Either one stops the follow-up being due and counts as a reply on Pipeline >
--    Conversations. A reply needs a sent note: un-marking the note clears the reply first.
-- 2. email_reply_dismissed_at: when John last clicked "Not replied" on an email. The hourly mailbox sync never stamps a
--    reply at or before that time again, so his call sticks; a reply that arrives later still counts.
alter table public.gtm_outreach_drafts
  add column linkedin_replied_at timestamptz,
  add column email_reply_dismissed_at timestamptz,
  add constraint gtm_outreach_drafts_linkedin_replied_needs_sent
    check (linkedin_replied_at is null or linkedin_status in ('sent', 'connected'));
