-- The bank (John, 2026-11-02: no seasons). "Not now" for a piece is a status, banked, instead of a date after the
-- season ends. A banked row is never scheduled; John schedules it from the calendar's bank.
alter table public.gtm_content_items
  drop constraint gtm_content_items_status,
  add constraint gtm_content_items_status
    check (status in ('idea', 'drafted', 'approved', 'scheduled', 'published', 'failed', 'skipped', 'banked'));

-- The old reserve bank: unsent rows dated after Season 1 ended (2026-12-11). They become banked, so no scheduler
-- treats their far-off dates as planned slots.
update public.gtm_content_items
  set status = 'banked', updated_at = now()
  where date > date '2026-12-11'
    and status in ('idea', 'drafted', 'approved')
    and zernio_post_id is null;
