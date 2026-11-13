# YouTube and Substack stats on /performance

The weekly YouTube entry (impressions, click-through rate) and the Substack subscriber numbers no longer have to be typed in.

## What each source gives

| Source | Gives | Cadence |
|---|---|---|
| YouTube Analytics API | views, watch time, average view duration and percentage, subscribers gained and lost, likes, comments, shares; by day, by video, by traffic source, by country | daily cron `/api/cron/youtube` |
| YouTube Reporting API, report `channel_reach_basic_a1` | thumbnail impressions and click-through rate per video per day (the Analytics API does not expose them; the reach reports were added January 2026) | same cron; the report job is created on first run and files appear within about a day |
| YouTube Data API | live subscriber total, titles, durations, publish dates | same cron |
| Studio export zips | daily views per video, traffic source and country, video metadata. A fallback and a backfill that only fills days and videos the API has not already written (existing rows are skipped); impressions are period totals in the export, so they are not imported | `gtm youtube import <zip>...` |
| Substack exports | subscribers at week end, new subscribers and unique visitors per week. Substack has no API; opens and post views are in neither export and stay manual | `gtm substack import` |

Tables: `gtm_yt_videos`, `gtm_yt_video_daily`, `gtm_yt_channel_daily`, `gtm_yt_dim_daily`, `gtm_yt_report_files` (schema owned by the website repository). Each finished week's impressions and CTR are written to `gtm_manual_metrics` (`entered_by = youtube-api`), so the existing YouTube row completes itself. A week John typed by hand is never overwritten. A week is rolled up only once all seven of its days have impressions: reach reports lag views by three or four days, and a week summed early would stay an undercount. Until then the sync leaves the row as it is and lists the week under `partialWeeks` (CLI: "not rolled up yet"). When Google reissues a day's reach report, the newest file replaces that day's reach: a video the new file no longer names has its impressions and CTR cleared, its views and other figures untouched.

## One-time setup (the channel owner)

1. In a Google Cloud project, enable **YouTube Analytics API**, **YouTube Reporting API** and **YouTube Data API v3**.
2. OAuth consent screen: user type **Internal** if the channel's Google account is in the organization (refresh tokens do not expire), otherwise External and publish the app (a testing-mode token expires after 7 days).
3. Create an OAuth client of type **Desktop app**. Store its id and secret: `dotenvx set YOUTUBE_CLIENT_ID "$(pbpaste)" -f .env.team`, then the secret the same way.
4. Run `gtm youtube auth` signed in as the channel owner. It prints the consent URL, waits on `127.0.0.1`, and writes the refresh token to a private temp file (never printed). Store it with the command it prints, then delete the file.
5. Set the three `YOUTUBE_*` values in the Vercel project, then `gtm youtube sync --days 90` to backfill what the API still holds.

## Check the first sync against Studio

The reach report returns CTR as a fraction; `parseReach` converts it to percent. Confirm once: for 7 Oct to 3 Nov 2026 the Studio table showed 1,925 impressions at 2.44% CTR. After a sync, the weighted total on /performance for the same window should match. The parser refuses a file whose CTR is above 1 (it expects a fraction) or whose columns changed. The sync skips that file, reports it as `reach file skipped`, keeps going, and retries it on the next run; fix `parseReach` once you know the real scale.

## Substack

```
gtm substack import --list regenera --file subscriber-export-….csv --growth iamregenera_growth_sources_….csv
gtm substack import --list personal --file subscriber-export-….csv --growth iamjohnellison_growth_sources_….csv
```

Add `--dry-run` to preview. Earlier weeks' subscriber counts are today's subscribers by start date, so they leave out people who have since left. Weeks before the growth file's first row get no visitor or new-subscriber number (unknown, not zero).
