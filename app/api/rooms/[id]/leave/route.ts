import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import { leaveRoom, MembershipError } from "@/lib/rooms/membership";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type LeaveContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/leave — leave a room the signed-in user belongs to.
 *
 * As with join, identity comes from the session only: the body accepts no
 * fields, so another student's membership can never be named here. Only the
 * caller's own student row is deleted inside `leave_room`, and the owner is
 * refused because they remain responsible for the room.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "membership": "left", "member_count": n \| null }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing or inaccessible room |
 * | 409 | `{ "error": { "code": "owner_cannot_leave" \| "not_a_member" } }` |
 * | 500 | `{ "error": { "code": "leave_failed" } }` |
 *
 * `member_count` is the aggregate seat usage for a public room and `null` for
 * a private one, so private occupancy is never disclosed.
 */
export async function POST(request: NextRequest, { params }: LeaveContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to leave this room.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const bodyResponse = emptyBodyResponse(await readEmptyBody(request));
  if (bodyResponse) {
    return bodyResponse;
  }

  try {
    const result = await leaveRoom(supabase, parsedRoomId.data);
    return NextResponse.json({
      membership: result.membership,
      member_count: result.member_count,
    });
  } catch (error) {
    if (error instanceof MembershipError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/leave] failed:", error);
    return errorResponse(
      "leave_failed",
      "You could not leave this room. Please try again.",
      500,
    );
  }
}
