import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import { joinRoom, MembershipError } from "@/lib/rooms/membership";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type JoinContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/join — join an open public room as the signed-in user.
 *
 * Identity comes from the session only; the body carries no fields at all, so
 * a forged `user_id` is rejected rather than ignored. The room id is validated
 * before it reaches the database, and the outcome below is produced by the
 * `join_room` RPC, which derives `auth.uid()` itself and locks the room row
 * for the capacity check.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "membership": "joined", "member_count": n }` |
 * | 200 | `{ "membership": "already_member", "member_count": n }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing or private room |
 * | 409 | `{ "error": { "code": "room_closed" \| "room_full" } }` |
 * | 500 | `{ "error": { "code": "join_failed" } }` |
 *
 * A private room answers 404 exactly like a nonexistent one, so the endpoint
 * never reveals that a private room exists.
 */
export async function POST(request: NextRequest, { params }: JoinContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to join this room.", 401);
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
    const result = await joinRoom(supabase, parsedRoomId.data);
    return NextResponse.json(
      { membership: result.membership, member_count: result.member_count },
      { status: result.membership === "joined" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof MembershipError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/join] failed:", error);
    return errorResponse(
      "join_failed",
      "The room could not be joined. Please try again.",
      500,
    );
  }
}
