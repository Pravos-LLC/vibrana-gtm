-- Email outcomes (Linear VIB-496 metrics, VIB-497 suppression; this slice VIB-508). Additive: every existing reader and
-- writer keeps working unchanged, and no existing row is dropped. Contract: VIB-496 "Cross-system email contract v1".
--
-- The facts are kept apart on purpose. A CRM address match is identity, not deliverability. No failure observed is not
-- delivered or verified. A human reply is correspondence, not marketing permission. A restriction belongs to one
-- address unless a person opted out. No address, subject, snippet or body is stored anywhere below: recipients are keyed
-- hashes (lib/team/crypto.ts addressHash in the cockpit), people are Twenty ids.
--
-- 1. gtm_team_mailboxes records the Gmail scopes Google actually granted. A stored metadata-only grant stays usable for
--    metadata collection; body-dependent work (reply classification) checks the granted scope, not the requested one.
-- 2. gtm_team_mail_events gains the mailbox the message was read from (Gmail ids are per mailbox, not per member), a
--    keyed hash of the RFC Message-ID so a forwarded or copied observation is not a second send, the desk draft when
--    known, the observation source and a calculation version. Legacy rows keep mailbox null until reconciled. The old
--    (member, gmail_message_id) constraint stays until the cockpit's writer switches; a later migration retires it.
-- 3. gtm_email_attempts: one row per outbound message and recipient. Message totals count events; bounce denominators
--    count attempts; contact and reply measures count distinct people and outreach episodes.
-- 4. gtm_email_reply_labels: append-only reply decisions (human, model, deterministic, provider, legacy). Intent and
--    opt-out are separate typed answers. A human decision outranks a model one. A decision is never edited or deleted, not
--    even by the service role: a correction marks the old row superseded (once) and inserts a new one. draft_id has no
--    foreign key on purpose, so the history outlives a deleted desk draft.
-- 5. gtm_email_sync_ops: each restriction per destination (Twenty, Origami) with its own state, from pending review to
--    read-back confirmed, so a CRM write never implies provider enforcement.
-- 6. gtm_email_incidents: durable, de-duplicated health incidents shown to and emailed to both owners.
-- 7. gtm_dmarc_reports: DMARC aggregate report totals per report. Source IPs and counts only.
-- 8. gtm_job_leases + gtm_take_lease/gtm_release_lease: overlap protection for the hourly and daily jobs.
-- 9. gtm_outreach_drafts: the new reply labels are allowed next to the legacy five, with who decided (human or model)
--    and whether email_replied_at came from Gmail or was dated by a label.

-- ---- 1. granted scopes ----------------------------------------------------------------------------------------

alter table public.gtm_team_mailboxes
  add column granted_scopes text[] not null default '{}'
    check (cardinality(granted_scopes) <= 20 and array_position(granted_scopes, null) is null),
  add column scopes_checked_at timestamptz;

-- Every existing connection was made by the cockpit's metadata-only consent screen, the only scope it has ever
-- requested. scopes_checked_at stays null: this is inferred from the requesting code, not read back from Google.
update public.gtm_team_mailboxes
  set granted_scopes = array['https://www.googleapis.com/auth/gmail.metadata']
  where granted_scopes = '{}';

grant select (granted_scopes, scopes_checked_at) on public.gtm_team_mailboxes to authenticated;

-- ---- 2. message identity -------------------------------------------------------------------------------------

alter table public.gtm_team_mail_events
  add column mailbox text
    check (mailbox is null or (mailbox ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and mailbox = lower(mailbox))),
  add column message_key text check (message_key is null or message_key ~ '^[A-Za-z0-9_-]{32,64}$'),
  add column source text not null default 'team_mailbox' check (source in ('team_mailbox', 'hq_forward')),
  add column draft_id uuid references public.gtm_outreach_drafts (id) on delete set null,
  add column calc_version smallint not null default 1 check (calc_version between 1 and 99);

create unique index gtm_team_mail_events_mailbox_once
  on public.gtm_team_mail_events (mailbox, gmail_message_id) where mailbox is not null;
create index gtm_team_mail_events_message_key_idx
  on public.gtm_team_mail_events (message_key) where message_key is not null;
create index gtm_team_mail_events_draft_idx
  on public.gtm_team_mail_events (draft_id) where draft_id is not null;

-- ---- 3. recipient attempts -----------------------------------------------------------------------------------

create table public.gtm_email_attempts (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.gtm_team_mail_events (id) on delete restrict,
  recipient_hash text not null check (recipient_hash ~ '^[A-Za-z0-9_-]{32,64}$'),
  hash_version smallint not null default 1 check (hash_version between 1 and 9),
  field text not null check (field in ('to', 'cc', 'bcc')),
  -- Identity: matched means exactly one Twenty person holds this address (primary or additional).
  match text not null check (match in ('matched', 'ambiguous', 'unmatched')),
  person_id uuid,
  stream text not null check (stream in ('cold', 'other_crm', 'unknown')),
  -- What was known about this exact address when it was sent (at_send), reconstructed later (inferred), or nothing.
  verification text not null default 'unknown' check (verification in ('verified', 'unverified', 'invalid', 'unknown')),
  verification_basis text not null default 'none' check (verification_basis in ('at_send', 'inferred', 'none')),
  -- Policy the send broke when it happened (e.g. CLIENT, NOT_SENDABLE, ADDRESS_RESTRICTED). Counted, flagged, never hidden.
  policy_flags text[] not null default '{}'
    check (cardinality(policy_flags) <= 20 and array_position(policy_flags, null) is null),
  attribution text not null default 'observed' check (attribution in ('observed', 'inferred')),
  episode_id text check (episode_id is null or episode_id ~ '^[a-f0-9]{32,64}$'),
  first_touch boolean,
  delivery text not null default 'no_failure_observed' check (delivery in (
    'no_failure_observed', 'delayed', 'failed_invalid_address', 'failed_policy', 'failed_unclassified', 'conflicting')),
  delivery_event_id bigint references public.gtm_team_mail_events (id) on delete set null,
  delivery_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_email_attempts_once unique (event_id, recipient_hash),
  constraint gtm_email_attempts_person check ((match = 'matched') = (person_id is not null)),
  constraint gtm_email_attempts_cold_matched check (stream <> 'cold' or match = 'matched'),
  constraint gtm_email_attempts_delivery_dated check ((delivery = 'no_failure_observed') = (delivery_at is null))
);
create index gtm_email_attempts_person_idx on public.gtm_email_attempts (person_id) where person_id is not null;
create index gtm_email_attempts_episode_idx on public.gtm_email_attempts (episode_id) where episode_id is not null;
create index gtm_email_attempts_failed_idx on public.gtm_email_attempts (delivery_at) where delivery <> 'no_failure_observed';

-- ---- 4. reply decisions --------------------------------------------------------------------------------------

create table public.gtm_email_reply_labels (
  id bigint generated always as identity primary key,
  event_id bigint references public.gtm_team_mail_events (id) on delete restrict,
  draft_id uuid,
  person_id uuid,
  episode_id text check (episode_id is null or episode_id ~ '^[a-f0-9]{32,64}$'),
  source text not null check (source in ('human', 'model', 'deterministic', 'provider', 'legacy')),
  intent text not null check (intent in (
    'interested', 'not_interested', 'not_now', 'referral', 'neutral', 'auto_reply', 'uncertain')),
  opt_out text not null default 'none' check (opt_out in ('none', 'person', 'address', 'uncertain')),
  model text check (model is null or length(model) between 1 and 80),
  decision_version smallint check (decision_version is null or decision_version between 1 and 99),
  labeled_by text check (labeled_by is null or length(labeled_by) <= 254),
  labeled_at timestamptz not null default now(),
  superseded_at timestamptz,
  constraint gtm_email_reply_labels_target check (event_id is not null or draft_id is not null),
  constraint gtm_email_reply_labels_model check ((source = 'model') = (model is not null)),
  constraint gtm_email_reply_labels_human check (source <> 'human' or labeled_by is not null)
);
create index gtm_email_reply_labels_event_idx on public.gtm_email_reply_labels (event_id) where event_id is not null;
create index gtm_email_reply_labels_draft_idx on public.gtm_email_reply_labels (draft_id) where draft_id is not null;
create index gtm_email_reply_labels_person_idx on public.gtm_email_reply_labels (person_id) where person_id is not null;
-- One current decision per source and reply; a correction supersedes the old row.
create unique index gtm_email_reply_labels_current_event
  on public.gtm_email_reply_labels (event_id, source) where superseded_at is null and event_id is not null;
create unique index gtm_email_reply_labels_current_draft
  on public.gtm_email_reply_labels (draft_id, source) where superseded_at is null and event_id is null;

-- The only change a decision accepts: superseded_at set once, nothing else touched. Deletes are refused.
create function public.gtm_email_reply_labels_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.superseded_at is null and new.superseded_at is not null
     and (to_jsonb(new) - 'superseded_at') = (to_jsonb(old) - 'superseded_at') then
    return new;
  end if;
  raise exception 'reply decisions are append-only: supersede a decision, never edit or delete it' using errcode = 'insufficient_privilege';
end $$;
revoke all on function public.gtm_email_reply_labels_append_only() from public, anon, authenticated;
create trigger gtm_email_reply_labels_append_only before update or delete on public.gtm_email_reply_labels
  for each row execute function public.gtm_email_reply_labels_append_only();

-- ---- 5. destination-specific restriction state ---------------------------------------------------------------

create table public.gtm_email_sync_ops (
  id bigint generated always as identity primary key,
  op_key text not null check (op_key ~ '^[a-z0-9:_.-]{8,200}$'),
  destination text not null check (destination in ('twenty', 'origami')),
  action text not null check (action in (
    'person_opt_out', 'address_restrict', 'address_opt_out', 'exclusion_upsert', 'exclusion_release')),
  person_id uuid,
  company_id uuid,
  address_hash text check (address_hash is null or address_hash ~ '^[A-Za-z0-9_-]{32,64}$'),
  reason text not null check (reason ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  evidence_event_id bigint references public.gtm_team_mail_events (id) on delete set null,
  label_id bigint references public.gtm_email_reply_labels (id) on delete set null,
  policy_version text not null check (length(policy_version) between 1 and 40),
  state text not null default 'pending_review' check (state in (
    'pending_review', 'approved', 'queued', 'applied', 'confirmed', 'failed', 'held', 'canceled')),
  approval_ref text check (approval_ref is null or length(approval_ref) <= 200),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) <= 500),
  observed_at timestamptz not null,
  approved_at timestamptz,
  applied_at timestamptz,
  confirmed_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gtm_email_sync_ops_once unique (op_key, destination),
  -- What each action needs: an address action names the address and its person; a person opt-out names the person.
  constraint gtm_email_sync_ops_target check (
    (action in ('address_restrict', 'address_opt_out') and address_hash is not null and person_id is not null)
    or (action = 'person_opt_out' and person_id is not null)
    or (action in ('exclusion_upsert', 'exclusion_release') and (person_id is not null or company_id is not null or address_hash is not null))),
  constraint gtm_email_sync_ops_approved check (state in ('pending_review', 'held', 'canceled') or approved_at is not null),
  constraint gtm_email_sync_ops_confirmed check ((state = 'confirmed') = (confirmed_at is not null))
);
create index gtm_email_sync_ops_open_idx on public.gtm_email_sync_ops (state, next_attempt_at)
  where state not in ('confirmed', 'canceled');

-- ---- 6. incidents --------------------------------------------------------------------------------------------

create table public.gtm_email_incidents (
  id bigint generated always as identity primary key,
  incident_key text not null check (incident_key ~ '^[a-z0-9:._-]{3,160}$'),
  kind text not null check (kind ~ '^[a-z][a-z_]{2,39}$'),
  severity text not null check (severity in ('warning', 'critical')),
  summary text not null check (length(summary) between 1 and 300),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  acknowledged_by text check (acknowledged_by is null or length(acknowledged_by) <= 254),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  constraint gtm_email_incidents_ack check ((acknowledged_by is null) = (acknowledged_at is null)),
  constraint gtm_email_incidents_order check (last_seen_at >= opened_at and (resolved_at is null or resolved_at >= opened_at))
);
-- One open incident per key: a repeat observation updates last_seen_at; a resolved incident can reopen as a new row.
create unique index gtm_email_incidents_open_once on public.gtm_email_incidents (incident_key) where resolved_at is null;
create index gtm_email_incidents_opened_idx on public.gtm_email_incidents (opened_at desc);

-- ---- 7. DMARC aggregate reports ------------------------------------------------------------------------------

create table public.gtm_dmarc_reports (
  report_key text primary key check (report_key ~ '^[a-f0-9]{64}$'),
  reporter text not null check (length(reporter) between 1 and 200),
  domain text not null check (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  begin_at timestamptz not null,
  end_at timestamptz not null,
  messages integer not null check (messages >= 0),
  dmarc_pass integer not null check (dmarc_pass >= 0),
  dkim_aligned integer not null check (dkim_aligned >= 0),
  spf_aligned integer not null check (spf_aligned >= 0),
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  received_at timestamptz not null default now(),
  constraint gtm_dmarc_reports_window check (end_at >= begin_at),
  constraint gtm_dmarc_reports_counts check (dmarc_pass <= messages and dkim_aligned <= messages and spf_aligned <= messages)
);
create index gtm_dmarc_reports_domain_idx on public.gtm_dmarc_reports (domain, end_at desc);

-- ---- 8. job leases -------------------------------------------------------------------------------------------

create table public.gtm_job_leases (
  job text primary key check (job ~ '^[a-z0-9._-]{2,60}$'),
  holder text not null check (length(holder) between 1 and 100),
  expires_at timestamptz not null,
  acquired_at timestamptz not null default now()
);

-- Take the job's lease if it is free, expired, or already ours. True when held by p_holder after the call.
create function public.gtm_take_lease(p_job text, p_holder text, p_seconds integer)
returns boolean language plpgsql volatile set search_path = '' as $$
declare taken boolean;
begin
  if p_seconds is null or p_seconds < 10 or p_seconds > 3600 then
    raise exception 'lease duration must be between 10 and 3600 seconds' using errcode = '22023';
  end if;
  insert into public.gtm_job_leases as l (job, holder, expires_at)
    values (p_job, p_holder, now() + make_interval(secs => p_seconds))
    on conflict (job) do update set holder = excluded.holder, expires_at = excluded.expires_at, acquired_at = now()
      where l.expires_at < now() or l.holder = excluded.holder
    returning true into taken;
  return coalesce(taken, false);
end $$;

create function public.gtm_release_lease(p_job text, p_holder text)
returns void language sql volatile set search_path = '' as $$
  delete from public.gtm_job_leases where job = p_job and holder = p_holder;
$$;

revoke all on function public.gtm_take_lease(text, text, integer), public.gtm_release_lease(text, text)
  from public, anon, authenticated;
grant execute on function public.gtm_take_lease(text, text, integer), public.gtm_release_lease(text, text) to service_role;

-- ---- 9. desk drafts ------------------------------------------------------------------------------------------

alter table public.gtm_outreach_drafts drop constraint gtm_outreach_drafts_reply_sentiment_check;
alter table public.gtm_outreach_drafts
  add constraint gtm_outreach_drafts_reply_sentiment_check check (reply_sentiment is null or reply_sentiment in (
    'positive', 'neutral', 'negative', 'not_now', 'unsubscribe',
    'interested', 'not_interested', 'referral', 'auto_reply', 'uncertain')),
  add column reply_label_source text check (reply_label_source is null or reply_label_source in ('human', 'model')),
  add column email_replied_at_source text
    check (email_replied_at_source is null or email_replied_at_source in ('gmail', 'label'));

-- Every stored label so far was John's click in the inbox. A reply date equal to the label time was dated by the
-- label (app/pipeline/actions.ts) because Gmail had not supplied one; other dates stay unknown (null), not guessed.
update public.gtm_outreach_drafts set reply_label_source = 'human' where reply_sentiment is not null;
update public.gtm_outreach_drafts set email_replied_at_source = 'label'
  where email_replied_at is not null and email_replied_at = reply_labeled_at;

-- ---- access: the owner reads, the service role writes; leases are service-only --------------------------------

alter table public.gtm_email_attempts enable row level security;
alter table public.gtm_email_reply_labels enable row level security;
alter table public.gtm_email_sync_ops enable row level security;
alter table public.gtm_email_incidents enable row level security;
alter table public.gtm_dmarc_reports enable row level security;
alter table public.gtm_job_leases enable row level security;
revoke all on public.gtm_email_attempts, public.gtm_email_reply_labels, public.gtm_email_sync_ops,
  public.gtm_email_incidents, public.gtm_dmarc_reports, public.gtm_job_leases from anon, authenticated;
grant all on public.gtm_email_attempts, public.gtm_email_reply_labels, public.gtm_email_sync_ops,
  public.gtm_email_incidents, public.gtm_dmarc_reports, public.gtm_job_leases to service_role;
grant select on public.gtm_email_attempts, public.gtm_email_reply_labels, public.gtm_email_sync_ops,
  public.gtm_email_incidents, public.gtm_dmarc_reports to authenticated;

create policy gtm_email_attempts_owner_read on public.gtm_email_attempts for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_email_reply_labels_owner_read on public.gtm_email_reply_labels for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_email_sync_ops_owner_read on public.gtm_email_sync_ops for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_email_incidents_owner_read on public.gtm_email_incidents for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
create policy gtm_dmarc_reports_owner_read on public.gtm_dmarc_reports for select to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'gtm_owner')::boolean, false));
