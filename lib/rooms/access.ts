import type { SupabaseClient } from "@supabase/supabase-js";

/** Failure carrying the HTTP status the API layer returns. */
export class RoomAccessError extends Error {
  readonly code: "not_found";
  readonly status: 404;

  constructor(message: string) {
    super(message);
    this.name = "RoomAccessError";
    this.code = "not_found";
    this.status = 404;
  }
}

const ROOM_MISSING = "That room does not exist or is not available.";

/**
 * Confirms the caller belongs to a room before an endpoint answers anything
 * else about it.
 *
 * The query only selects the caller's own rows (`room_members_select_own`), so
 * a caller who is not a member matches nothing — and a room that does not
 * exist matches nothing. Both become the same 404, which keeps the workspace
 * and the goal endpoints from becoming an existence oracle.
 */
export async function requireRoomMembership(
  client: SupabaseClient,
  roomId: string,
): Promise<void> {
  const { data, error } = await client
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .limit(1);

  if (error) {
    throw new Error(`membership check failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new RoomAccessError(ROOM_MISSING);
  }
}
