import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { CommunityAccessError } from "@/lib/communities/access";
import { CommunityError, leaveCommunity } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { communityIdSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type LeaveContext = { params: Promise<{ id: string }> };

/**
 * POST /api/communities/[id]/leave — leave a community. The owner must
 * transfer or delete first (`owner_cannot_leave`, 409). Cryptographic exit
 * is the client's job: after this returns, the leaving device runs a self-
 * Remove commit on each channel group so its key schedule advances past the
 * messages it should no longer read; the server cannot and does not hold
 * keys to do it for them.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 204 | empty |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "owner_cannot_leave" } }` |
 * | 500 | `{ "error": { "code": "community_leave_failed" } }` |
 */
async function POST_raw(_request: NextRequest, { params }: LeaveContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to leave communities.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  try {
    await leaveCommunity(supabase, parsedId.data);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/leave] failed:", errorFields(error));
    return errorResponse(
      "community_leave_failed",
      "You could not leave the community. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
