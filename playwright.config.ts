import { defineConfig, devices } from "@playwright/test";

// Proxy probes + end-to-end, against `next start` and the LOCAL Supabase stack.
// Run through `pnpm test:e2e`, which points every env var at local services first (docs/testing.md).
const PORT = Number(process.env.GTM_E2E_PORT ?? 3100);
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    colorScheme: "light",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    // Never reuse a stray server: the one under test must be built against the local stack.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
