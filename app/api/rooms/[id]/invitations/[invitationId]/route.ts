import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import {
  InvitationError,
  revokeInvitation,
} from "@/lib/invitations/queries";
import {
  requireRoomOwner,
  RoomAccessError,
  RoomOwnerError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { invitationIdSchema } from "@/lib/validation/invitations";
import { roomIdSchema } from "@/lib/validation/rooms";

type RevokeContext = { params: Promise<{ id: string; invitationId: string }> };

/**
 * DELETE /api/rooms/[id]/invitations/[invitationId] — revoke a pending
 * invitation (owner only).
 *
 * The route proves owner first; the RPC then re-checks that the caller is
 * still the inviter *and* still the room's owner, locks the row, and refuses
 * anything already resolved. An accepted invitation is no longer an
 * invitation, so it answers 404 — revocation is not retroactive and not an
 * edit of history. Idempotent from the caller's side: a second revoke of the
 * same row is also 404, with no way to tell the two apart.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "revoked": true }` |
 * | 400 | `{ "error": { "code": "validation" } }` — either id is not a UUID |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room, somebody else's invitation, or already resolved |
 * | 500 | `{ "error": { "code": "invitation_revoke_failed" } }` |
 */
export async function DELETE(request: NextRequest, { params }: RevokeContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to revoke an invitation.", 401);
  }

  const { id, invitationId } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  const parsedInvitationId = invitationIdSchema.safeParse(invitationId);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }
  if (!parsedInvitationId.success) {
    return errorResponse("validation", "That invitation id is not valid.", 400, [
      { path: "invitationId", message: "Invitation id must be a UUID." },
    ]);
  }

  try {
    await requireRoomOwner(supabase, parsedRoomId.data);
    await revokeInvitation(supabase, parsedInvitationId.data);
    return NextResponse.json({ revoked: true });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof RoomOwnerError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof InvitationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/invitations] revoke failed:", error);
    return errorResponse(
      "invitation_revoke_failed",
      "The invitation could not be revoked.",
      500,
    );
  }
}
