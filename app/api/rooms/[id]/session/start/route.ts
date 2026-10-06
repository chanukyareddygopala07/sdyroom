import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { FocusSessionError, startFocusSession } from "@/lib/focus/sessions";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import { startSessionSchema } from "@/lib/validation/focus";

type StartContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/session/start — start the shared focus timer.
 *
 * Owner only (enforced inside the RPC), so a member who calls this gets 403
 * rather than silently starting a timer for everyone. A repeat call while a
 * session is already running is not an error: it answers 200 with the session
 * that is already going, and a concurrent race resolves to a single row
 * through the partial unique index.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "action": "started", "session": {...} }` |
 * | 200 | `{ "action": "already_active", "session": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "start_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: StartContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse(
      "unauthenticated",
      "Sign in to start a focus session.",
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

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse(
      "invalid_json",
      "The request body must be JSON.",
      400,
    );
  }

  const parsedStart = startSessionSchema.safeParse(parsedBody.body);
  if (!parsedStart.success) {
    return validationResponse(parsedStart.error);
  }

  try {
    const result = await startFocusSession(
      supabase,
      parsedRoomId.data,
      parsedStart.data.duration_seconds,
    );
    return NextResponse.json(
      { action: result.action, session: result.session },
      { status: result.action === "started" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof FocusSessionError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/session/start] failed:", error);
    return errorResponse(
      "start_failed",
      "The focus session could not be started. Please try again.",
      500,
    );
  }
}
