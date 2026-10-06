import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import { endFocusSession, FocusSessionError } from "@/lib/focus/sessions";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type EndContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/session/end — stop the timer early as completed.
 *
 * Owner only. The session is recorded as `completed` (someone ended it) as
 * opposed to `expired` (the deadline passed with nobody acting), and both
 * states then appear in the workspace history.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "action": "completed", "session": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "no_active_session" } }` |
 * | 500 | `{ "error": { "code": "end_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: EndContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse(
      "unauthenticated",
      "Sign in to end the focus session.",
      401,
    );
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
    const result = await endFocusSession(supabase, parsedRoomId.data);
    return NextResponse.json({
      action: result.action,
      session: result.session,
    });
  } catch (error) {
    if (error instanceof FocusSessionError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/session/end] failed:", error);
    return errorResponse(
      "end_failed",
      "The focus session could not be ended. Please try again.",
      500,
    );
  }
}
