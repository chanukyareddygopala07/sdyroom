import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import { FocusSessionError, pauseFocusSession } from "@/lib/focus/sessions";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type PauseContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/session/pause — freeze the running timer.
 *
 * Owner only; the body must be empty (a field would be reported back as a 400
 * rather than ignored). The remaining time stops moving until a resume credits
 * the paused interval back to the deadline.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "action": "paused", "session": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "no_active_session" \| "invalid_state" } }` |
 * | 500 | `{ "error": { "code": "pause_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: PauseContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse(
      "unauthenticated",
      "Sign in to pause the focus session.",
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
    const result = await pauseFocusSession(supabase, parsedRoomId.data);
    return NextResponse.json({
      action: result.action,
      session: result.session,
    });
  } catch (error) {
    if (error instanceof FocusSessionError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/session/pause] failed:", error);
    return errorResponse(
      "pause_failed",
      "The focus session could not be paused. Please try again.",
      500,
    );
  }
}
