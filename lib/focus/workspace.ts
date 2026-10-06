import type { SupabaseClient } from "@supabase/supabase-js";
import { toPublicRoom } from "@/lib/rooms/shape";
import { PUBLIC_ROOM_COLUMNS, type PublicRoom } from "@/lib/rooms/types";
import { FocusSessionError, readFocusState, toFocusSession } from "./sessions";
import {
  FOCUS_HISTORY_LIMIT,
  FOCUS_SESSION_COLUMNS,
  type FocusSession,
  type ViewerRole,
} from "./types";

export type FocusWorkspace = {
  room: PublicRoom;
  session: FocusSession | null;
  viewer_role: ViewerRole;
  server_now_ms: number;
  member_count: number;
  history: FocusSession[];
};

/**
 * Everything the workspace renders, for members only.
 *
 * The membership check is the read RPC itself: a non-member (or a room that
 * does not exist) fails after one call and never learns which of the two it
 * was. Expiry is persisted as part of that read, so a session whose deadline
 * passed while nobody was watching is recorded before anyone sees it.
 *
 * The page and `GET /api/rooms/[id]/workspace` both come through here — the
 * client never calls itself over HTTP to refresh.
 */
export async function getFocusWorkspace(
  client: SupabaseClient,
  roomId: string,
): Promise<FocusWorkspace> {
  const state = await readFocusState(client, roomId);

  const [roomResult, historyResult] = await Promise.all([
    client
      .from("rooms")
      .select(PUBLIC_ROOM_COLUMNS)
      .eq("id", roomId)
      .maybeSingle(),
    client
      .from("focus_sessions")
      .select(FOCUS_SESSION_COLUMNS)
      .eq("room_id", roomId)
      .in("state", ["completed", "expired"])
      .order("ended_at", { ascending: false })
      .limit(FOCUS_HISTORY_LIMIT),
  ]);

  if (roomResult.error) {
    throw new Error(`workspace room query failed: ${roomResult.error.message}`);
  }
  if (!roomResult.data) {
    // Unreachable through the API: the read above already confirmed membership.
    throw new FocusSessionError(
      "not_found",
      "That room does not exist or is not available.",
      404,
    );
  }

  if (historyResult.error) {
    throw new Error(
      `workspace history query failed: ${historyResult.error.message}`,
    );
  }

  return {
    room: toPublicRoom(roomResult.data as Record<string, unknown>),
    session: state.session,
    viewer_role: state.viewer_role,
    server_now_ms: state.server_now_ms,
    member_count: state.member_count,
    history: (historyResult.data ?? []).map((row) => toFocusSession(row)),
  };
}
