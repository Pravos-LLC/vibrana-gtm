-- Playbook tags (VIB-421): the cockpit's `gtm playbook tag` labels each approved, scheduled or published
-- calendar item with the content-canon taxonomy ids for its hook, storyline and CTA (plus a rationale,
-- a confidence and a hash of the body it describes). The weekly content report reads them to grade the
-- week against the creator playbooks. Writes come from the service role only (existing RLS); the column
-- does not touch body or media, so the approval-reset trigger leaves approval alone.

alter table public.gtm_content_items
  add column playbook_tags jsonb
    constraint gtm_content_items_playbook_tags_object
    check (playbook_tags is null or jsonb_typeof(playbook_tags) = 'object');
