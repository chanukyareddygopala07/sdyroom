import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import { FocusSessionError, resumeFocusSession } from "@/lib/focus/sessions";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type ResumeContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/session/resume — continue a paused timer.
 *
 * Owner only; the paused interval is added back to the deadline, so the
 * countdown resumes exactly where it stopped. Any state read that happened
 * while paused never moved the clock.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "action": "resumed", "session": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "no_active_session" \| "invalid_state" } }` |
 * | 500 | `{ "error": { "code": "resume_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: ResumeContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse(
      "unauthenticated",
      "Sign in to resume the focus session.",
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
    const result = await resumeFocusSession(supabase, parsedRoomId.data);
    return NextResponse.json({
      action: result.action,
      session: result.session,
    });
  } catch (error) {
    if (error instanceof FocusSessionError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/session/resume] failed:", error);
    return errorResponse(
      "resume_failed",
      "The focus session could not be resumed. Please try again.",
      500,
    );
  }
}
