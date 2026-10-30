# Local demo

Install Node.js, pnpm, PostgreSQL client tools (`psql`), the Supabase CLI and a running Docker-compatible container runtime. From a fresh clone:

```sh
pnpm install --frozen-lockfile
pnpm demo:setup
pnpm demo
```

Open http://127.0.0.1:3100 and sign in with `owner@gtm.test` / `gtm-test-password-1`.
The launcher copies the committed migrations and a demo-specific configuration to ignored `node_modules/.cache/gtm-demo`, using project `vibrana-gtm-demo` independently of the normal test stack. The dashboard uses synthetic fixtures in the dedicated local Supabase stack on ports 61321/61322. `demo:setup` starts that stack and replaces its fixture data; run it again to restore the initial demo. It does not reset or connect to a hosted project. No hub checkout, `.env` file, macOS service or live provider account is required. Supabase downloads its local service images on the first run.

For the CLI, use `pnpm demo:gtm accounts --json` or `pnpm demo:gtm plan --json`. Stop the dashboard with Ctrl-C and stop the demo stack with `pnpm demo:stop`.

The launcher sets `DEMO_MODE=1`, forces sample content, removes inherited provider credentials and takes database connection details directly from the local stack. Provider boundaries also reject live email, publishing, model, enrichment, financial and public media operations, including injected transports. Unsupported actions show a demo-disabled error. Local edits and approvals may update fixtures, but posting cannot reach a live account. Owner authentication and normal claim checks remain active.

Setting `DEMO_MODE=1` manually also refuses any database URL outside the dedicated loopback API on port 61321. Use the launcher to supply local keys and sample content consistently.
