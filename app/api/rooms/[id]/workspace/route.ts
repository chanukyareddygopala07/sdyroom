import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { FocusSessionError } from "@/lib/focus/sessions";
import { getFocusWorkspace } from "@/lib/focus/workspace";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";

type WorkspaceContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/workspace — everything the study workspace renders.
 *
 * Shared with the page itself through `getFocusWorkspace`, so a client that
 * refreshes after a reconnect or a missed realtime event reads exactly what
 * the server rendered: the room, the active session (or none), the viewer's
 * own role, seat count, server clock and recent terminal sessions.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ room, session, viewer_role, server_now_ms, member_count, history }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — non-member or missing room |
 * | 500 | `{ "error": { "code": "workspace_failed" } }` |
 *
 * A non-member and a nonexistent room are the same 404, so the URL cannot be
 * used to discover which rooms exist.
 */
export async function GET(request: NextRequest, { params }: WorkspaceContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view this room.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  try {
    const workspace = await getFocusWorkspace(supabase, parsedRoomId.data);
    return NextResponse.json(workspace);
  } catch (error) {
    if (error instanceof FocusSessionError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/workspace] failed:", error);
    return errorResponse(
      "workspace_failed",
      "The room workspace could not be loaded.",
      500,
    );
  }
}
