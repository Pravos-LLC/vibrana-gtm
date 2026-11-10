-- Origami opt-outs (Linear VIB-521). Additive: every existing reader and writer keeps working unchanged.
--
-- Origami has no global suppression: its org exclusion list blocks no API enrollment (VIB-497 scope test) and an
-- "Unsubscribe" reply only stops that one sequence. The cockpit carries an Origami opt-out into the Twenty CRM's
-- suppression and stops the person's sequences in every Origami campaign.
--
-- 1. gtm_origami_replies: one row per piece of Origami evidence, a lead's reply (from the webhook or the hourly poll) or a
--    sequence Origami itself marked unsubscribed. The webhook and the poll see the same reply under one evidence key
--    (sequence and received time), so either path, in any order and any number of times, records it once. No reply body,
--    subject, address or LinkedIn URL is stored: a keyed hash of the body, the recipient address and the LinkedIn slug
--    (lib/team/crypto.ts), Origami ids and Twenty person ids only.
-- 2. gtm_origami_webhook_deliveries: the webhook-id of every verified delivery (Origami delivers at least once).
-- 3. gtm_email_reply_labels: a decision may now be about an Origami reply instead of a Gmail event or a desk draft.
-- 4. gtm_email_sync_ops: a new Origami action, sequence_stop, names the campaign and sequence it stops; evidence_ref is
--    the plain evidence line an applied opt-out appends to the person's consent evidence (ids and dates only).

-- ---- 1. Origami evidence ----------------------------------------------------------------------------------------

create table public.gtm_origami_replies (
  id bigint generated always as identity primary key,
  evidence_key text not null
    check (evidence_key ~ '^(reply:[0-9a-f-]{36}:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z|status:[0-9a-f-]{36})$'),
  kind text not null check (kind in ('reply', 'unsubscribed_status')),
  source text not null check (source in ('webhook', 'poll', 'status_scan')),
  origami_reply_id uuid,
  sequence_id uuid not null,
  campaign_id uuid,
  channel text check (channel is null or channel in ('email', 'linkedin')),
  received_at timestamptz not null,
  body_hash text check (body_hash is null or body_hash ~ '^[A-Za-z0-9_-]{16,64}$'),
  rule_version text not null check (length(rule_version) between 1 and 40),
  classification text not null check (classification in ('confirmed', 'possible', 'none')),
  reason text not null check (reason ~ '^[a-z][a-z0-9_]{1,40}$'),
  first_on_sequence boolean,
  -- Who it is in Twenty: exactly one person by address, else by LinkedIn slug. Zero or several is a person's review.
  match text not null default 'pending' check (match in ('pending', 'matched', 'ambiguous', 'unmatched', 'not_needed')),
  person_id uuid,
  recipient_hash text check (recipient_hash is null or recipient_hash ~ '^[A-Za-z0-9_-]{32,64}$'),
  linkedin_hash text check (linkedin_hash is null or linkedin_hash ~ '^[A-Za-z0-9_-]{32,64}$'),
  sequences_found integer check (sequences_found is null or sequences_found >= 0),
  processed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) <= 300),
  -- An unmatched or ambiguous opt-out stays a health incident until a person records that they handled it.
  reviewed_at timestamptz,
  reviewed_by text check (reviewed_by is null or length(reviewed_by) between 1 and 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_origami_replies_once unique (evidence_key),
  constraint gtm_origami_replies_reply_once unique (origami_reply_id),
  constraint gtm_origami_replies_person check ((match = 'matched') = (person_id is not null)),
  constraint gtm_origami_replies_none check ((classification = 'none') = (match = 'not_needed')),
  constraint gtm_origami_replies_reviewed check ((reviewed_at is null) = (reviewed_by is null))
);
create index gtm_origami_replies_open_idx on public.gtm_origami_replies (created_at) where processed_at is null and classification <> 'none';
create index gtm_origami_replies_sequence_idx on public.gtm_origami_replies (sequence_id, received_at);
create index gtm_origami_replies_person_idx on public.gtm_origami_replies (person_id) where person_id is not null;

-- ---- 2. webhook deliveries --------------------------------------------------------------------------------------

create table public.gtm_origami_webhook_deliveries (
  webhook_id text primary key check (length(webhook_id) between 1 and 200),
  event text not null check (event ~ '^[a-z][a-z0-9._]{1,60}$'),
  received_at timestamptz not null default now()
);

-- ---- 3. reply decisions about an Origami reply ------------------------------------------------------------------

alter table public.gtm_email_reply_labels
  add column origami_reply_id bigint references public.gtm_origami_replies (id) on delete restrict;
alter table public.gtm_email_reply_labels drop constraint gtm_email_reply_labels_target;
alter table public.gtm_email_reply_labels add constraint gtm_email_reply_labels_target
  check (event_id is not null or draft_id is not null or origami_reply_id is not null);
create unique index gtm_email_reply_labels_current_origami
  on public.gtm_email_reply_labels (origami_reply_id, source) where superseded_at is null and origami_reply_id is not null;

-- ---- 4. stopping an Origami sequence ----------------------------------------------------------------------------

alter table public.gtm_email_sync_ops
  add column origami_campaign_id uuid,
  add column origami_sequence_id uuid,
  add column evidence_ref text check (evidence_ref is null or length(evidence_ref) between 1 and 300);
alter table public.gtm_email_sync_ops drop constraint gtm_email_sync_ops_action_check;
alter table public.gtm_email_sync_ops add constraint gtm_email_sync_ops_action_check check (action in (
  'person_opt_out', 'address_restrict', 'address_opt_out', 'exclusion_upsert', 'exclusion_release', 'sequence_stop'));
alter table public.gtm_email_sync_ops drop constraint gtm_email_sync_ops_target;
alter table public.gtm_email_sync_ops add constraint gtm_email_sync_ops_target check (
  (action in ('address_restrict', 'address_opt_out') and address_hash is not null and person_id is not null)
  or (action = 'person_opt_out' and person_id is not null)
  or (action in ('exclusion_upsert', 'exclusion_release') and (person_id is not null or company_id is not null or address_hash is not null))
  -- A stop names its campaign and sequence; the person may be unknown to Twenty (an unmatched opt-out still stops).
  or (action = 'sequence_stop' and destination = 'origami' and origami_campaign_id is not null and origami_sequence_id is not null));
create index gtm_email_sync_ops_sequence_idx on public.gtm_email_sync_ops (origami_sequence_id) where origami_sequence_id is not null;
create index gtm_email_reply_labels_origami_idx on public.gtm_email_reply_labels (origami_reply_id) where origami_reply_id is not null;

-- ---- access: the owner reads the evidence, the service role writes; deliveries are service-only -------------------

alter table public.gtm_origami_replies enable row level security;
alter table public.gtm_origami_webhook_deliveries enable row level security;
revoke all on public.gtm_origami_replies, public.gtm_origami_webhook_deliveries from anon, authenticated;
grant all on public.gtm_origami_replies, public.gtm_origami_webhook_deliveries to service_role;
grant select on public.gtm_origami_replies to authenticated;
create policy gtm_origami_replies_owner_read on public.gtm_origami_replies for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
