# Contributing

Read [AGENTS.md](AGENTS.md) and [deployment context](docs/deployment.md). This public repository is the active source; protected `main` merges deploy the live cockpit.

Use synthetic fixtures and explicit sample mode for local checks: `CONTENT_MODE=sample pnpm typecheck`, `CONTENT_MODE=sample pnpm test:coverage` and `CONTENT_MODE=sample pnpm build`. Run the applicable local database/browser checks defined in CI. Required executable checks and independent exact-head review must pass before an authorized merge.

Database changes belong in the website schema-owner repository. Never connect CI or previews to a production database, import private configuration into public fixtures, or weaken the application's final delivery approval. Keep source changes in a dedicated worktree and preserve existing uncommitted work. The frozen private archive is historical context, not a development or CI target.
