-- First live sync rejected two kinds of real YouTube values:
--  * Shorts loop, so the average percentage viewed can exceed 100 (the looping is signal, keep it).
--  * Daily likes, comments, shares and subscriber gains and losses are net of removals, so a day can be negative.
alter table public.gtm_yt_video_daily drop constraint if exists gtm_yt_video_daily_avg_view_pct_check;
alter table public.gtm_yt_video_daily add constraint gtm_yt_video_daily_avg_view_pct_check check (avg_view_pct >= 0);
alter table public.gtm_yt_video_daily drop constraint if exists gtm_yt_video_daily_likes_check;
alter table public.gtm_yt_video_daily drop constraint if exists gtm_yt_video_daily_comments_check;
alter table public.gtm_yt_video_daily drop constraint if exists gtm_yt_video_daily_shares_check;
alter table public.gtm_yt_video_daily drop constraint if exists gtm_yt_video_daily_subs_gained_check;
alter table public.gtm_yt_video_daily drop constraint if exists gtm_yt_video_daily_subs_lost_check;
alter table public.gtm_yt_channel_daily drop constraint if exists gtm_yt_channel_daily_subs_gained_check;
alter table public.gtm_yt_channel_daily drop constraint if exists gtm_yt_channel_daily_subs_lost_check;
