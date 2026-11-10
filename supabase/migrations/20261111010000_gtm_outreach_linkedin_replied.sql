-- Writing desk (VIB-522): a reply to a warm stream's LinkedIn note. LinkedIn has no API for messages, so John marks the
-- reply on the desk ("Mark replied") and this column records when. An email reply already has email_status 'replied' and
-- email_replied_at (20261105030000_gtm_pipeline.sql). Either one stops the follow-up being due and counts as a reply on
-- Pipeline > Conversations. A reply needs a sent note: un-marking the note clears the reply first.
alter table public.gtm_outreach_drafts
  add column linkedin_replied_at timestamptz,
  add constraint gtm_outreach_drafts_linkedin_replied_needs_sent
    check (linkedin_replied_at is null or linkedin_status in ('sent', 'connected'));
