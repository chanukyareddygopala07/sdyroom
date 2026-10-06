import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { integrationEnv } from "../../integration/helpers/env";

export const E2E_PASSWORD = "Browser!Pass123";

let sequence = 0;

/**
 * Unique per worker process and per call: parallel workers can never collide
 * on an email or on the case-insensitively unique alias. The global teardown
 * deletes everything under the shared `e2e+<run>-` prefix in one statement.
 */
function runScoped(label: string): { email: string; alias: string } {
  sequence += 1;
  const run = process.env.E2E_RUN_ID ?? "norun";
  const id = `${run}w${process.pid}n${sequence}`;
  return {
    email: `e2e+${id}-${label}@example.com`,
    alias: `e2e${id}`,
  };
}

export type E2EUser = { email: string; password: string };

/**
 * Signs up through the real form. The local stack auto-confirms, so the
 * session exists immediately and the app sends the user to onboarding.
 * Stops after onboarding lands them on `/rooms`.
 */
export async function signUpAndOnboard(page: Page, label: string): Promise<E2EUser> {
  const { email, alias } = runScoped(label);
  await page.goto("/auth/sign-up");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator("#repeat-password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL(/\/onboarding$/);
  await page.locator("#alias").fill(alias);
  await page.getByRole("button", { name: /continue to rooms/i }).click();
  await page.waitForURL(/\/rooms$/);
  return { email, password: E2E_PASSWORD };
}

/** Authenticates an already-registered user through the login form. */
export async function login(page: Page, user: E2EUser): Promise<void> {
  await page.goto("/auth/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: /login/i }).click();
  await page.waitForURL(/\/rooms$/);
}

/**
 * Registers a user through the API (no browser) for tests that only need the
 * account to exist; the caller then logs in through the UI where the session
 * matters.
 */
export async function signUpViaApi(label: string): Promise<E2EUser> {
  const { apiUrl, publishableKey } = integrationEnv();
  const client = createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { email } = runScoped(label);
  const { data, error } = await client.auth.signUp({
    email,
    password: E2E_PASSWORD,
  });
  if (error) {
    throw new Error(`API sign-up failed for ${email}: ${error.message}`);
  }
  if (!data.session) {
    throw new Error(
      `API sign-up for ${email} returned no session; the local stack must run ` +
        "with enable_confirmations = false.",
    );
  }
  return { email, password: E2E_PASSWORD };
}
