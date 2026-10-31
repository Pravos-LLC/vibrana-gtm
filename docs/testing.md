# Sample-mode validation

Public CI uses synthetic configuration and isolated local services. It does not receive private guide/runtime data, delivery credentials or production provider secrets. Keep that boundary when reproducing a failure locally.

## Standard checks

```sh
pnpm install --frozen-lockfile
CONTENT_MODE=sample pnpm typecheck
CONTENT_MODE=sample pnpm test:coverage
CONTENT_MODE=sample pnpm build
```

The sample build needs the public Supabase configuration described by `.env.example`; the dedicated demo launcher supplies its local configuration automatically. Use synthetic values or the isolated local stack, never production credentials. Media tests need ffmpeg. Coverage is reported under the existing informational policy; do not reinterpret it as permission to remove executable tests or change other gates.

## Local database and browser checks

With the Supabase CLI, PostgreSQL client tools and a running Docker-compatible container runtime:

```sh
pnpm db:start
CONTENT_MODE=sample pnpm check:migrations
CONTENT_MODE=sample pnpm test:db:sql
CONTENT_MODE=sample pnpm test:db
CONTENT_MODE=sample pnpm test:db:advisors
pnpm exec playwright install chromium
CONTENT_MODE=sample pnpm test:e2e
pnpm db:stop
```

Use the local environment wrapper invoked by these scripts. The vendored migration manifest supports reproducible local replay; it does not authorize a hosted database reset, production seed import or history repair. Keep advisor exceptions, authorization checks, provider mocks and delivery approvals intact.

## Required PR checks

Workflow files define the executable commands and workflow checks. Branch protection also requires the separately reported provider check:

- `typecheck, unit + contract tests, build`
- `database, RLS, storage + advisors (local Supabase)`
- `proxy probes + end-to-end (Playwright)`
- `gitleaks`
- `dependency audit`
- `Vercel – vibrana-gtm-public-preview` (provider status from the Vercel GitHub App, app ID 8329)

Run the relevant local checks for a change and retain the required hosted checks. A green sample preview proves sample behavior, not the actual private production configuration. Production replacement additionally needs the runtime, authorization and data checks in [deployment context](deployment.md) and [private data loading](private-overlay.md).
