import { NextResponse, type NextRequest } from "next/server";
import { emptyBodyResponse, errorResponse, readEmptyBody } from "@/lib/api/responses";
import { ModerationError } from "@/lib/moderation/errors";
import { setModerator } from "@/lib/moderation/queries";
import {
  requireRoomMembership,
  RoomAccessError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { memberAliasSchema } from "@/lib/validation/moderation";
import { roomIdSchema } from "@/lib/validation/rooms";

type ModeratorContext = {
  params: Promise<{ id: string; alias: string }>;
};

/**
 * Moderator grants live in `room_moderators` (zero public grants; the RPC
 * is the only writer) and never change the `room_members` row — `role`
 * there stays `owner | student`. POST grants, DELETE revokes; both are
 * bodyless and owner-only: moderators cannot mint or revoke moderators.
 * The owner's own grant is refused (409 `cannot_moderate_owner`).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "role": "moderator" \| "student", "changed": boolean, "granted": boolean }` — `changed: false` is the idempotent repeat |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_request" } }` — bad ids, alias, or a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` — moderators cannot change moderator grants |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room, non-member, unknown alias, or caller lacks rights |
 * | 409 | `{ "error": { "code": "cannot_moderate_owner" } }` |
 * | 500 | `{ "error": { "code": "moderation_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: ModeratorContext) {
  return setModeratorFlag(request, params, true);
}

/**
 * DELETE /api/rooms/[id]/members/[alias]/moderator — revoke a moderator
 * grant. Same contract as POST; `role: "student"` + `changed: true` means
 * the grant is gone.
 */
export async function DELETE(
  request: NextRequest,
  { params }: ModeratorContext,
) {
  return setModeratorFlag(request, params, false);
}

async function setModeratorFlag(
  request: NextRequest,
  paramsPromise: Promise<{ id: string; alias: string }>,
  on: boolean,
) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse(
      "unauthenticated",
      "Sign in to manage moderators.",
      401,
    );
  }

  const { id, alias } = await paramsPromise;
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
    const result = await setModerator(
      supabase,
      parsedRoomId.data,
      parsedAlias.data,
      on,
    );
    return NextResponse.json({
      role: result.role,
      changed: result.changed,
      granted: on,
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

    console.error("[api/rooms/members/moderator] failed:", error);
    return errorResponse(
      "moderation_failed",
      "That moderator grant could not be changed. Please try again.",
      500,
    );
  }
}
