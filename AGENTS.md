# Repository instructions

Read this file, then [RESOLVER.md](RESOLVER.md), before working in this repository. When operating in the managed private hub, also follow its current governing instructions and routing to private operating authority. Archived source is frozen historical context, not the active development checkout.

## Development and releases

- This public repository is the active source. Protected `main` merges deploy the live Vercel cockpit. Follow the task's merge authorization and required release checks; a sample preview is not production validation.
- Work in a dedicated branch/worktree. In the managed hub, create it with `bin/vibrana wt add vibrana-gtm <type>/<task>`. Preserve dirty worktrees and unpushed changes. Never edit or commit in a shared primary checkout.
- Use conventional commits and the configured human Git identity. Stage explicit paths, push and open a focused PR. Do not add generated branding or automated co-author trailers.
- Required executable CI and an independent review of the exact source head must pass before merge. Keep substantive review evidence private and outside the product repository; public references may use neutral review IDs. Re-review changed heads and resolve blocking findings.
- Never deploy through the Vercel CLI. Provider changes, promotion, rollback and live job dispatch must follow the task's authorization and the current operating procedure.

## Data and security boundaries

- Public CI, tests, demos and previews use samples. Samples are not production guide, editorial, account or commercial authority.
- Private production content/configuration is structured, revision- and hash-pinned data, never executable source overrides. Keep it and provider credentials out of public Git, CI, previews, logs, client bundles and shared sample caches.
- Preserve owner/team/reviewer authorization, provider delivery approval, demo guards, provenance checks and database security tests. Do not send or schedule live content merely to test a change.
- Schema changes belong in the website repository. Never reset production or treat neutral demo migration history as production migration instructions.
- Never print or commit credentials, plaintext environment files, invitation maps, private guide data, real account/mailbox configuration or client material. Use synthetic fixtures and report verification by names, fingerprints or status only.
- Private archives have Actions disabled. Relocated private workflows remain held; do not infer automatic Sunday jobs or dispatch from old source.

## Navigation and validation

Prefer codebase-memory-mcp when available: `search_graph` with project `vibrana-gtm`, then `trace_path` and `get_code_snippet`. Index a missing project first; index a worktree under a distinct key. Verify current source before editing. Use targeted file search when graph results are unavailable or insufficient, and read documentation/configuration normally.

Run the checks appropriate to the change. Standard code checks are `pnpm typecheck`, `pnpm test:coverage`, `pnpm build` and the local database/browser checks defined in CI. Keep sample mode explicit and retain all existing check requirements. Documentation-only work still needs link/privacy validation and the required PR checks.
