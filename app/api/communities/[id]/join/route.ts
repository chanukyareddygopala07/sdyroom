import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { CommunityAccessError } from "@/lib/communities/access";
import { CommunityError, joinCommunity } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { communityIdSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityJoinSpec } from "@/lib/rate-limit/keys";

type JoinContext = { params: Promise<{ id: string }> };

/**
 * POST /api/communities/[id]/join — join an open community or file an access
 * request. The RPC pins the caller to `auth.uid()`, blocks banned users, and
 * only bumps the member count on the active path. The client's next step for
 * an `active` result is the MLS sync: the joiner's devices are Added to each
 * channel group by an existing member's client on their next visit.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "status": "active" \| "requested" }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` (banned) |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "community_join_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: JoinContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to join communities.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityJoinSpec(parsedId.data, claims.sub),
    "You're joining communities too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const status = await joinCommunity(supabase, parsedId.data);
    return NextResponse.json({ status });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/join] failed:", errorFields(error));
    return errorResponse(
      "community_join_failed",
      "The community could not be joined. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
