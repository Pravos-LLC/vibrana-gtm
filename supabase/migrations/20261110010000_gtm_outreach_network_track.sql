-- A third writing-desk stream (VIB-522): John's own network. People he already knows (a prior conversation, a LinkedIn,
-- WhatsApp or Gmail connection), each note written by hand, sent from user-f538cb95fc21@example.com, 15 a day. It is a warm
-- stream like the guests (20261019000000_gtm_outreach_tracks.sql): any route (email or a LinkedIn note) counts toward the
-- target, it gets the single follow-up, and it never enters a cold send queue. No new columns: route, follow_up_status and
-- follow_up_sent_at already carry everything a warm stream needs.
--
-- 1. 'network' joins the track check on gtm_outreach_tracks, gtm_outreach_dossiers, gtm_outreach_drafts and
--    gtm_outreach_angle_runs (each constraint is dropped and re-added under its own generated name).
-- 2. gtm_outreach_tracks gets the network row: target 15, its sender. An existing row is left as it is.
--
-- Additive: the client and guest streams behave exactly as before, and a cockpit that lags this migration never reads the
-- new row (it asks for its two tracks by name).

-- ---- 1. the track checks ------------------------------------------------------------------------------------------------
alter table public.gtm_outreach_tracks drop constraint gtm_outreach_tracks_track_check;
alter table public.gtm_outreach_tracks
  add constraint gtm_outreach_tracks_track_check check (track in ('client', 'guest', 'network'));

alter table public.gtm_outreach_dossiers drop constraint gtm_outreach_dossiers_track_check;
alter table public.gtm_outreach_dossiers
  add constraint gtm_outreach_dossiers_track_check check (track in ('client', 'guest', 'network'));

alter table public.gtm_outreach_drafts drop constraint gtm_outreach_drafts_track_check;
alter table public.gtm_outreach_drafts
  add constraint gtm_outreach_drafts_track_check check (track in ('client', 'guest', 'network'));

alter table public.gtm_outreach_angle_runs drop constraint gtm_outreach_angle_runs_track_check;
alter table public.gtm_outreach_angle_runs
  add constraint gtm_outreach_angle_runs_track_check check (track in ('client', 'guest', 'network'));

-- ---- 2. the network stream's settings -----------------------------------------------------------------------------------
insert into public.gtm_outreach_tracks (track, daily_target, from_address)
  values ('network', 15, 'user-f538cb95fc21@example.com')
  on conflict (track) do nothing;
