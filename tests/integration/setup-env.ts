import { vi } from "vitest";
import { assertSchemaApplied } from "./helpers/admin";
import { prepareIntegrationEnv } from "./helpers/env";

/**
 * The session cookie seam: route handlers call `cookies()` from `next/headers`
 * inside `createClient()`, so the mock is registered once for the whole suite
 * and backed by the shared jar in `cookie-jar.ts`.
 */
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./helpers/cookie-jar");
  return { cookies: async () => cookieStore() };
});

await prepareIntegrationEnv();
assertSchemaApplied();
