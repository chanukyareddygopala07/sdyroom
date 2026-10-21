import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityStaff } from "@/lib/communities/access";
import {
  CommunityError,
  kickCommunityMember,
  leaveCommunity,
  setCommunityMember,
} from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityIdSchema,
  setCommunityMemberSchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityMemberSpec } from "@/lib/rate-limit/keys";

type MemberContext = { params: Promise<{ id: string; userId: string }> };

/**
 * PATCH /api/communities/[id]/members/[userId] — approve a request
 * (`status: "active"`), ban (`"banned"`), or change a role
 * (`role: "moderator"` / `"member"`). The RPC pins the actor's staff role,
 * protects the owner row, and only the owner may appoint moderators.
 * A ban revokes API/RLS access immediately; the cryptographic member removal
 * is committed by a remaining member's client on its next sync.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "ok": true }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "owner_protected" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "member_update_failed" } }` |
 */
async function PATCH_raw(request: NextRequest, { params }: MemberContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to manage members.", 401);
  }

  const { id, userId } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  const parsedUserId = communityIdSchema.safeParse(userId);
  if (!parsedId.success || !parsedUserId.success) {
    return errorResponse("validation", "That id is not valid.", 400, [
      { path: "id", message: "Community and user ids must be UUIDs." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = setCommunityMemberSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }
  if (parsed.data.role == null && parsed.data.status == null) {
    return errorResponse(
      "validation",
      "Provide a role or a status to change.",
      400,
    );
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityMemberSpec(parsedId.data, claims.sub),
    "You're updating members too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityStaff(supabase, parsedId.data, claims.sub);
    await setCommunityMember(supabase, parsedId.data, parsedUserId.data, {
      role: parsed.data.role ?? null,
      status: parsed.data.status ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/members] update failed:", errorFields(error));
    return errorResponse(
      "member_update_failed",
      "The member could not be updated. Please try again.",
      500,
    );
  }
}

export const PATCH = withLogging(PATCH_raw);

/**
 * DELETE /api/communities/[id]/members/[userId] — remove (kick) a member.
 * The membership row disappears, so an open community lets them rejoin; a
 * ban is the PATCH `status: "banned"` path. The owner row cannot be removed
 * (`owner_protected`), and the caller's own row can always be removed (this
 * is also the leave path for clients that prefer DELETE semantics). Removal
 * runs through the `kick_community_member` RPC — the table carries no DELETE
 * grant — which also keeps `member_count` honest in the same transaction.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 204 | empty |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "owner_protected" } }` |
 * | 500 | `{ "error": { "code": "member_remove_failed" } }` |
 */
async function DELETE_raw(_request: NextRequest, { params }: MemberContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to manage members.", 401);
  }

  const { id, userId } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  const parsedUserId = communityIdSchema.safeParse(userId);
  if (!parsedId.success || !parsedUserId.success) {
    return errorResponse("validation", "That id is not valid.", 400, [
      { path: "id", message: "Community and user ids must be UUIDs." },
    ]);
  }

  try {
    if (parsedUserId.data === claims.sub) {
      // Leaving goes through the RPC so the member count stays honest.
      try {
        await leaveCommunity(supabase, parsedId.data);
        return new NextResponse(null, { status: 204 });
      } catch (error) {
        if (error instanceof CommunityError || error instanceof CommunityAccessError) {
          return errorResponse(error.code, error.message, error.status);
        }
        throw error;
      }
    }

    await requireCommunityStaff(supabase, parsedId.data, claims.sub);

    // Removal itself is the SECURITY DEFINER RPC: authenticated holds no
    // DELETE grant on community_members, so the kick and the member_count
    // decrement exist only there (guards: staff actor, target exists,
    // owner protected).
    await kickCommunityMember(supabase, parsedId.data, parsedUserId.data);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/members] remove failed:", errorFields(error));
    return errorResponse(
      "member_remove_failed",
      "The member could not be removed. Please try again.",
      500,
    );
  }
}

export const DELETE = withLogging(DELETE_raw);
