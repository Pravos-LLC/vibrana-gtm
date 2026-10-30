-- Cover the lesson foreign key so lesson deletion can find resolutions without scanning the table.
-- A concurrent earlier migration (20261028010000) creates the same index on fresh replays.
create index if not exists gtm_red_flag_resolutions_lesson_idx
  on public.gtm_red_flag_resolutions (lesson_id);
