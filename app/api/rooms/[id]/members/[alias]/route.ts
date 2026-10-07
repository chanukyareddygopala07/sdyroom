import { NextResponse, type NextRequest } from "next/server";
import { emptyBodyResponse, errorResponse, readEmptyBody } from "@/lib/api/responses";
import { ModerationError } from "@/lib/moderation/errors";
import { removeMember } from "@/lib/moderation/queries";
import {
  requireRoomMembership,
  RoomAccessError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { memberAliasSchema } from "@/lib/validation/moderation";
import { roomIdSchema } from "@/lib/validation/rooms";

type MemberContext = {
  params: Promise<{ id: string; alias: string }>;
};

/**
 * DELETE /api/rooms/[id]/members/[alias] — owner or moderator removes a
 * member from the room. Bodyless: identity comes from the path (alias) and
 * the actor from the session. The RPC's own rules refuse the owner, refuse
 * self-removal, sweep the target's moderator grant and active mute with the
 * membership, and serialise against joins on the room row lock. The response
 * carries the post-removal seat count for the owner's capacity view — never
 * any identity beyond the alias already in the path.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "removed": true, "member_count": number }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_request" } }` — bad ids, alias, or a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_moderator" } \| { "code": "not_owner" } \| { "code": "cannot_remove_owner" } \| { "code": "cannot_remove_self" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room, non-member, non-existent target, or caller lacks rights |
 * | 500 | `{ "error": { "code": "moderation_failed" } }` |
 */
export async function DELETE(request: NextRequest, { params }: MemberContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to manage members.", 401);
  }

  const { id, alias } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedAlias = memberAliasSchema.safeParse(alias);
  if (!parsedAlias.success) {
    return errorResponse("validation", "That alias is not valid.", 400, [
      { path: "alias", message: "Alias must be 1–32 characters." },
    ]);
  }

  const body = await readEmptyBody(request);
  const emptyBodyError = emptyBodyResponse(body);
  if (emptyBodyError) {
    return emptyBodyError;
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const result = await removeMember(
      supabase,
      parsedRoomId.data,
      parsedAlias.data,
    );
    return NextResponse.json({
      removed: true,
      member_count: result.member_count,
    });
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomAccessError) {
      return errorResponse(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }

    console.error("[api/rooms/members/remove] failed:", error);
    return errorResponse(
      "moderation_failed",
      "That member could not be removed. Please try again.",
      500,
    );
  }
}
