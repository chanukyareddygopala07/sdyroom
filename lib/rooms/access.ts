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

/** Failure for a member who is not the room's owner. */
export class RoomOwnerError extends Error {
  readonly code: "not_owner";
  readonly status: 403;

  constructor(message: string) {
    super(message);
    this.name = "RoomOwnerError";
    this.code = "not_owner";
    this.status = 403;
  }
}

/**
 * Confirms the caller is the owner of a room they are already a member of.
 *
 * The query reads only the caller's own row (`room_members_select_own`), so
 * a non-member matches nothing and gets the same 404 as
 * {@link requireRoomMembership} — the room's existence is not revealed by
 * asking whether you own it. A member who is not the owner gets 403: they
 * already know the room exists, so there is nothing left to hide.
 */
export async function requireRoomOwner(
  client: SupabaseClient,
  roomId: string,
): Promise<void> {
  const { data, error } = await client
    .from("room_members")
    .select("role")
    .eq("room_id", roomId)
    .limit(1);

  if (error) {
    throw new Error(`membership check failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new RoomAccessError(ROOM_MISSING);
  }

  if (data[0].role !== "owner") {
    throw new RoomOwnerError("Only the room owner can manage invitations.");
  }
}
