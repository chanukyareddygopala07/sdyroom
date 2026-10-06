import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
// localhost, not 127.0.0.1: Next's dev server only serves its resources
// (and therefore only hydrates the page) for origins it recognises.
const baseURL = `http://localhost:${PORT}`;

/**
 * One id per `playwright test` invocation, generated while the main process
 * loads this config and inherited by every worker, so all fixture emails
 * share a prefix that the global teardown can delete in one statement.
 */
if (!process.env.E2E_RUN_ID) {
  process.env.E2E_RUN_ID = `r${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * Browser end-to-end suite: real Chromium against `next dev` and the local
 * Supabase stack (see tests/e2e/README.md). Chromium only — the browser
 * build is pinned by the exact @playwright/test version in package.json.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  // Realtime propagation, reconnect and poll-phase waits are inherently
  // multi-second; 90s keeps them bounded without racing the dev server.
  timeout: 90_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The dev server compiles each route on first request, which is slower
    // than a warmed production build, especially on CI runners.
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
