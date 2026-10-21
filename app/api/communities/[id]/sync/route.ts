import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import {
  CommunityError,
  fetchCommunityKeyPackages,
  listActiveMemberIds,
} from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { communityIdSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type SyncContext = { params: Promise<{ id: string }> };

/**
 * GET /api/communities/[id]/sync — everything a member client needs to run
 * the MLS membership sync: the active member ids and every registered key
 * package. The client diffs that against each channel group's current
 * ratchet tree and, for any missing device, builds an Add commit (+ welcome
 * for the addressee) and POSTs the envelopes back through the normal
 * message/welcome endpoints. Runs are idempotent because a device already in
 * the tree is skipped by identity match.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "member_ids": [...], "devices": [...] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "sync_failed" } }` |
 */
async function GET_raw(_request: NextRequest, { params }: SyncContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to sync keys.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);

    const memberIds = await listActiveMemberIds(supabase, parsedId.data);
    const devices = await fetchCommunityKeyPackages(supabase, memberIds);

    return NextResponse.json({ member_ids: memberIds, devices });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/sync] failed:", errorFields(error));
    return errorResponse(
      "sync_failed",
      "The membership sync data could not be loaded.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);
