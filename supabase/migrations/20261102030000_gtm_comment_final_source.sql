-- Engage from Claude Code: who wrote the text John sent. `draft` is the cockpit agent's own draft; `john` is text
-- John typed or dictated; `chat_agent` is a rewrite Claude wrote in a Claude Code session and John approved. The
-- learning loop treats `edited` as John's voice, so a chat_agent rewrite must not count as one of his edits.
-- Null means the web UI (John's own tap and edits), the only path before this column existed.
alter table public.gtm_comments
  add column final_source text check (final_source in ('draft', 'john', 'chat_agent'));
