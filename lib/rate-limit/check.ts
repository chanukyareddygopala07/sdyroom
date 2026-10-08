import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import type { RateLimitSpec } from "./keys";

/**
 * Consumes one slot for `spec` and reports whether the caller may proceed.
 *
 * The counting itself lives in the `rate_limit_take()` RPC (see migration
 * 0010): one `INSERT ... ON CONFLICT` statement, atomic across every
 * instance of the app, so this works the same on one dev machine and on a
 * multi-instance deployment. There is no in-process memory involved and
 * therefore no multi-instance limitation to document — the counter is the
 * database.
 *
 * **Fails open.** If the limiter itself cannot be consulted (database
 * hiccup, a deployment where the RPC is missing), the request is allowed and
 * the failure is logged. That is the right trade here: the limiter is a
 * traffic-shaping control, and refusing every upload because a counter could
 * not be read would turn a transient error into an outage. The quota trigger
 * and RLS still guard correctness regardless of what this returns.
 */
export async function takeRateLimit(
  client: SupabaseClient,
  spec: RateLimitSpec,
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("rate_limit_take", {
      p_key: spec.key,
      p_max: spec.max,
      p_window: `${spec.windowSeconds} seconds`,
    });
    if (error) {
      console.error("[rate-limit] take failed:", spec.key.split(":")[0], error.message);
      return true;
    }
    // `false` is the RPC's only "no" answer. Anything else (a null from an
    // unexpected payload shape) is treated as allowed rather than blocking
    // the world on a surprise.
    return data !== false;
  } catch (error) {
    console.error(
      "[rate-limit] take threw:",
      spec.key.split(":")[0],
      error instanceof Error ? error.message : error,
    );
    return true;
  }
}

const DEFAULT_MESSAGE = "You are doing that too often — wait a moment and try again.";

/**
 * Returns the 429 response when the slot for `spec` is already spent, or
 * `null` when the request may continue.
 *
 * The body is the standard error envelope with `code: "rate_limited"`, plus
 * a `Retry-After` header naming the window so an honest client can back off
 * instead of guessing.
 */
export async function rateLimitedResponse(
  client: SupabaseClient,
  spec: RateLimitSpec,
  message: string = DEFAULT_MESSAGE,
): Promise<NextResponse | null> {
  const allowed = await takeRateLimit(client, spec);
  if (allowed) {
    return null;
  }
  const response = errorResponse("rate_limited", message, 429);
  response.headers.set("Retry-After", String(spec.windowSeconds));
  return response;
}
