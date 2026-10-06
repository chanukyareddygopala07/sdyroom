import { assertSchemaApplied } from "../integration/helpers/admin";
import { prepareIntegrationEnv } from "../integration/helpers/env";

/**
 * Runs once in the main process before workers spawn.
 *
 * It reuses the integration suite's environment guard so both suites share
 * one refusal rule set: loopback-only Supabase URL, publishable key only,
 * no service-role/secret variables, and a reachable API with migrations
 * applied. Everything resolved here (including `.env.local` values loaded
 * into `process.env`) is inherited by the workers and by `next dev`.
 */
export default async function globalSetup(): Promise<void> {
  await prepareIntegrationEnv();
  assertSchemaApplied();
}
