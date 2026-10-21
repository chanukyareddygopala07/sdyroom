import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import { CommunityError, listCommunityMembers } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { communityIdSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type MembersContext = { params: Promise<{ id: string }> };

/**
 * GET /api/communities/[id]/members — the active roster with display
 * aliases. Staff may add `?include_requested=1` to see pending requests for
 * approval. Aliases come from each member's own profile row, the same public
 * identity rooms already expose to co-members.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "members": [...] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "members_failed" } }` |
 */
async function GET_raw(request: NextRequest, { params }: MembersContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view members.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  const includeRequested =
    request.nextUrl.searchParams.get("include_requested") === "1";

  try {
    const access = await requireCommunityMembership(
      supabase,
      parsedId.data,
      claims.sub,
    );

    if (includeRequested && access.role === "member") {
      throw new CommunityAccessError(
        "forbidden",
        "Only community owners and moderators can list pending requests.",
        403,
      );
    }

    const members = await listCommunityMembers(supabase, parsedId.data, {
      includeRequested,
    });
    return NextResponse.json({ members });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/members] list failed:", errorFields(error));
    return errorResponse("members_failed", "Members could not be loaded.", 500);
  }
}

export const GET = withLogging(GET_raw);
