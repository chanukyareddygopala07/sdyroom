import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import { CommunityError, listPendingWelcomes } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { communityIdSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type CommunityWelcomesContext = { params: Promise<{ id: string }> };

/**
 * GET /api/communities/[id]/welcomes — the caller's pending welcome envelopes
 * across this community's channels, oldest first, each with its ratchet-tree
 * snapshot. The client consumes each one into its local MLS session store; a
 * welcome that fails to apply (wrong device, stale epoch) is dropped
 * client-side without erroring the page.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "welcomes": [...] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "welcomes_failed" } }` |
 */
async function GET_raw(_request: NextRequest, { params }: CommunityWelcomesContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view welcomes.", 401);
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

    const { data: channels } = await supabase
      .from("community_channels")
      .select("id")
      .eq("community_id", parsedId.data)
      .limit(200);

    const channelIds = ((channels ?? []) as Array<{ id: string }>).map((c) => c.id);
    const welcomes =
      channelIds.length > 0
        ? await listPendingWelcomes(supabase, claims.sub, { channelIds })
        : [];

    return NextResponse.json({ welcomes });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/welcomes] list failed:", errorFields(error));
    return errorResponse("welcomes_failed", "Welcomes could not be loaded.", 500);
  }
}

export const GET = withLogging(GET_raw);
