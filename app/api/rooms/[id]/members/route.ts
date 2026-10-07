import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import {
  RosterDeniedError,
  roomRoster,
} from "@/lib/invitations/queries";
import {
  requireRoomMembership,
  RoomAccessError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type MembersContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/members — the member roster for one room: display
 * alias, role, and when they joined. Presence is *not* part of this payload
 * (PR #6 keeps live presence in ephemeral Postgres NOTIFY only); the roster
 * client annotates rows from the presence store instead, so refreshing the
 * page never implies anyone is online.
 *
 * Two layers again: `requireRoomMembership` proves the caller belongs before
 * the RPC runs, and `room_roster` re-checks membership inside its own
 * SECURITY DEFINER transaction. The response contains no user ids — alias is
 * the display and addressable identity throughout.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "members": [{ alias, role, joined_at }], "count": number }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room, non-member, or left mid-request: all identical |
 * | 500 | `{ "error": { "code": "members_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: MembersContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view the roster.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const members = await roomRoster(supabase, parsedRoomId.data);
    return NextResponse.json({ members, count: members.length });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof RosterDeniedError) {
      return errorResponse(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }

    console.error("[api/rooms/members] failed:", error);
    return errorResponse(
      "members_failed",
      "The roster could not be loaded.",
      500,
    );
  }
}
