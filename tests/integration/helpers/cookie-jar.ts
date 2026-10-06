import { createServerClient } from "@supabase/ssr";
import { integrationEnv } from "./env";

type StoredCookie = { name: string; value: string };

/**
 * Cookie store backing the mocked `next/headers` `cookies()`. The route
 * handlers under test build their own SSR client on every request, so the jar
 * is the entire session surface: seed it before a call, clear it to simulate
 * an anonymous request.
 */
export const cookieJar: { cookies: StoredCookie[] } = { cookies: [] };

export function clearCookies(): void {
  cookieJar.cookies = [];
}

type CookieOptions = { maxAge?: number };

function applySet(args: unknown[]): void {
  let name: string;
  let value: string;
  let options: CookieOptions | undefined;

  if (typeof args[0] === "string") {
    name = args[0];
    value = String(args[1] ?? "");
    options = args[2] as CookieOptions | undefined;
  } else {
    const record = args[0] as { name?: string; value?: string } & CookieOptions;
    name = record.name ?? "";
    value = record.value ?? "";
    options = record;
  }

  cookieJar.cookies = cookieJar.cookies.filter((cookie) => cookie.name !== name);
  if (value !== "" && options?.maxAge !== 0) {
    cookieJar.cookies.push({ name, value });
  }
}

/**
 * Shape returned by Next's `cookies()`. `getAll`/`set` are what `@supabase/ssr`
 * uses; `get`/`delete` are included so a call site that expects the full
 * request-cookies API cannot crash the seam.
 */
export function cookieStore() {
  return {
    getAll: () => cookieJar.cookies.map((cookie) => ({ ...cookie })),
    get: (name: string) => cookieJar.cookies.find((cookie) => cookie.name === name),
    set: (...args: unknown[]) => applySet(args),
    delete: (...args: unknown[]) => {
      const name = typeof args[0] === "string" ? args[0] : String((args[0] as { name?: string })?.name ?? "");
      cookieJar.cookies = cookieJar.cookies.filter((cookie) => cookie.name !== name);
      return true;
    },
    remove: (name: string) => {
      cookieJar.cookies = cookieJar.cookies.filter((cookie) => cookie.name !== name);
    },
  };
}

/**
 * Signs a user in through a real SSR client so the session lands in the jar in
 * exactly the format the application reads it back in.
 */
export async function seedSession(email: string, password: string): Promise<void> {
  const { apiUrl, publishableKey } = integrationEnv();
  clearCookies();

  const client = createServerClient(apiUrl, publishableKey, {
    cookies: {
      getAll: () => cookieStore().getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) =>
          applySet([name, value, options]),
        );
      },
    },
  });

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`sign-in failed for ${email}: ${error.message}`);
  }
  if (cookieJar.cookies.length === 0) {
    throw new Error(
      `sign-in for ${email} produced no session cookies; the local stack must ` +
        "run with enable_confirmations = false so password sign-in returns a session.",
    );
  }
}
