import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import { CommunityError, fetchCommunityKeyPackages } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { fetchCommunityKeysSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityKeysFetchSpec } from "@/lib/rate-limit/keys";

/**
 * POST /api/communities/devices/fetch — key packages for the given users, at
 * most three freshest devices each. Only community members may fetch (the
 * caller's membership in `communityId` is checked), even though the packages
 * themselves are public credentials: keeping the endpoint member-gated limits
 * bulk harvesting to the audience that could actually use them in a commit.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "devices": [...] }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "keys_fetch_failed" } }` |
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to fetch key packages.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = fetchCommunityKeysSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityKeysFetchSpec(claims.sub),
    "You're fetching key packages too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityMembership(supabase, parsed.data.communityId, claims.sub);
    const devices = await fetchCommunityKeyPackages(supabase, parsed.data.userIds);
    return NextResponse.json({ devices });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/devices/fetch] failed:", errorFields(error));
    return errorResponse(
      "keys_fetch_failed",
      "Key packages could not be loaded. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
