-- Engage: what a commenter linked to (VIB-428). When a comment carries a link, the drafting run reads the page
-- and keeps a short summary next to the comment, so John sees what they shared and the draft can answer it.
-- One entry per link: {"url": "https://...", "title": "...", "summary": "..."}. Only the summary is kept,
-- never the page itself. Like every gtm_* column: RLS on the table, the owner reads, the service role writes.

alter table public.gtm_comments
  add column linked jsonb check (
    linked is null or (jsonb_typeof(linked) = 'array' and jsonb_array_length(linked) <= 3 and length(linked::text) <= 4000)
  );
