-- Covering index for gtm_red_flag_resolutions.lesson_id (20261028000000): the Supabase advisor flags a foreign key without one,
-- and gtm-cockpit's advisor check fails on any unlisted finding. Deleting a lesson scans this table for the set-null.
create index gtm_red_flag_resolutions_lesson_idx on public.gtm_red_flag_resolutions (lesson_id);
