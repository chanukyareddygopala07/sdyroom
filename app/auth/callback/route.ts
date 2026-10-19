import { safeInternalPath } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";

/**
 * OAuth return leg (PKCE): Supabase redirects the browser here with a
 * one-time `code`, which is exchanged server-side for the session cookies.
 *
 * - `next` is attacker-controllable, so it only ever becomes a destination
 *   after `safeInternalPath` accepts it (the same allow-list the email
 *   confirmation route uses) — anything else falls back to `/rooms`.
 * - Provider errors (denied consent, disabled provider, failed exchange)
 *   land on the login page with `?error=oauth`, which shows one reviewed
 *   line; the raw provider message is never echoed.
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = safeInternalPath(requestUrl.searchParams.get("next")) ?? "/rooms";
  const providerError = requestUrl.searchParams.get("error");

  const loginWithError = () =>
    NextResponse.redirect(
      new URL("/auth/login?error=oauth", requestUrl.origin),
    );

  if (providerError) {
    return loginWithError();
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return loginWithError();
    }
  }

  // Only a verified site-internal path is ever used as a target.
  return NextResponse.redirect(new URL(next, requestUrl.origin));
}
