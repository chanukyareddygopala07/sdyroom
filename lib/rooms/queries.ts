import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RoomSearchInput,
  UpdateRoomInput,
} from "@/lib/validation/rooms";
import { toPublicRoom } from "./shape";
import { PUBLIC_ROOM_COLUMNS, PUBLIC_ROOM_LIMIT, type PublicRoom } from "./types";

export class RoomQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomQueryError";
  }
}

/**
 * Failure carrying the HTTP status the API layer returns. Codes come from
 * `update_room` / `delete_room` envelopes (the 0002/0007 convention): SQL
 * text and constraint names never reach a response, and an unknown code
 * throws instead of being forwarded.
 */
export type RoomMutationErrorCode =
  | "not_found"
  | "not_owner"
  | "invalid_request"
  | "validation"
  | "capacity_below_membership";

export class RoomMutationError extends Error {
  readonly code: RoomMutationErrorCode;
  readonly status: number;
  /** Present only for `capacity_below_membership` — the floor that refused. */
  readonly memberCount?: number;

  constructor(
    code: RoomMutationErrorCode,
    message: string,
    status: number,
    memberCount?: number,
  ) {
    super(message);
    this.name = "RoomMutationError";
    this.code = code;
    this.status = status;
    if (memberCount !== undefined) {
      this.memberCount = memberCount;
    }
  }
}

const MUTATION_RESULTS: Record<
  string,
  { code: RoomMutationErrorCode; status: number; message: string }
> = {
  room_not_found: {
    code: "not_found",
    status: 404,
    message: "That room does not exist or is not available.",
  },
  not_owner: {
    code: "not_owner",
    status: 403,
    message: "Only the room owner can manage this room.",
  },
  invalid_request: {
    code: "invalid_request",
    status: 400,
    message: "Provide at least one field to update.",
  },
  validation: {
    code: "validation",
    status: 400,
    message: "Those room details are not valid.",
  },
};

function mutationError(envelope: {
  code?: unknown;
  member_count?: unknown;
}): RoomMutationError | null {
  const code = typeof envelope.code === "string" ? envelope.code : null;
  if (code === null || code === "updated" || code === "deleted") {
    return null;
  }

  if (code === "capacity_below_membership") {
    const count = Number(envelope.member_count);
    const memberCount = Number.isFinite(count) ? count : 0;
    return new RoomMutationError(
      "capacity_below_membership",
      `Capacity cannot be lower than the current member count (${memberCount}).`,
      409,
      memberCount,
    );
  }

  const mapped = MUTATION_RESULTS[code];
  if (!mapped) {
    throw new Error(`unexpected room mutation code: ${code}`);
  }
  return new RoomMutationError(mapped.code, mapped.message, mapped.status);
}

/**
 * The room row **for its owner only** — the settings page's gate.
 *
 * Two RLS reads, each scoped to the caller's own rows: the room row is
 * visible to any member (`rooms_select_member`), so membership decides
 * alone. A non-member matches no room row (404-equivalent `null`, identical
 * to a missing room), and a member who is not the owner reads their own
 * `room_members` row and finds `role = student` — also `null`. The page
 * turns `null` into `notFound()`, so `/rooms/[id]/settings` never reveals
 * which rooms exist and never renders owner controls to anyone else.
 */
export async function getOwnedRoom(
  client: SupabaseClient,
  roomId: string,
): Promise<PublicRoom | null> {
  const { data: roomRow, error: roomError } = await client
    .from("rooms")
    .select(PUBLIC_ROOM_COLUMNS)
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) {
    throw new RoomQueryError(roomError.message);
  }
  if (!roomRow) {
    return null;
  }

  const { data: membership, error: memberError } = await client
    .from("room_members")
    .select("role")
    .eq("room_id", roomId)
    .limit(1);

  if (memberError) {
    throw new RoomQueryError(memberError.message);
  }
  if (!membership || membership.length === 0 || membership[0].role !== "owner") {
    return null;
  }

  return toPublicRoom(roomRow as Record<string, unknown>);
}

/**
 * Edits a room through `update_room`: a partial change set under the room
 * row lock, owner re-proven from `auth.uid()`, capacity floored at the
 * current member count. Absent keys are dropped here (a patch value that is
 * `undefined` never reaches the RPC), so "unchanged" and "cleared" stay
 * distinct all the way down. The response is the updated row's public shape —
 * always re-read from the database, never the caller's input echoed back.
 */
export async function updateRoom(
  client: SupabaseClient,
  roomId: string,
  patch: UpdateRoomInput,
): Promise<PublicRoom> {
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.shared_goal !== undefined) changes.shared_goal = patch.shared_goal;
  if (patch.exam_track !== undefined) changes.exam_track = patch.exam_track;
  if (patch.subject !== undefined) changes.subject = patch.subject;
  if (patch.language !== undefined) changes.language = patch.language;
  if (patch.capacity !== undefined) changes.capacity = patch.capacity;
  if (patch.status !== undefined) changes.status = patch.status;

  const { data, error } = await client.rpc("update_room", {
    p_room_id: roomId,
    p_changes: changes,
  });

  if (error) {
    throw new Error(`update_room failed: ${error.message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("update_room returned no result");
  }

  const failure = mutationError(data as Record<string, unknown>);
  if (failure) {
    throw failure;
  }

  return toPublicRoom(data as Record<string, unknown>);
}

/**
 * Deletes a room through `delete_room` — owner-only, one cascade. Storage
 * cleanup has already happened at this point (the route removes objects
 * first); this function only decides whether the row may disappear.
 */
export async function deleteRoom(
  client: SupabaseClient,
  roomId: string,
): Promise<void> {
  const { data, error } = await client.rpc("delete_room", {
    p_room_id: roomId,
  });

  if (error) {
    throw new Error(`delete_room failed: ${error.message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("delete_room returned no result");
  }

  const failure = mutationError(data as Record<string, unknown>);
  if (failure) {
    throw failure;
  }
}

/**
 * Turns free text into a PostgREST `ilike` pattern. Wildcards and the
 * characters that structure a `.or()` filter are stripped so user input can
 * never escape its filter or widen the match.
 */
export function toIlikePattern(query: string): string {
  const cleaned = query
    .replace(/[%_]/g, " ")
    .replace(/["(),\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `%${cleaned}%`;
}

/**
 * Public room discovery. Visibility is filtered in the application as well as
 * by RLS, so a student's own private rooms can never show up here.
 */
export async function listPublicRooms(
  client: SupabaseClient,
  search: RoomSearchInput,
): Promise<PublicRoom[]> {
  const base = client
    .from("rooms")
    .select(PUBLIC_ROOM_COLUMNS)
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(PUBLIC_ROOM_LIMIT);

  let query = base;
  if (search.q !== "") {
    const pattern = toIlikePattern(search.q);
    query = base.or(
      `name.ilike."${pattern}",subject.ilike."${pattern}",exam_track.ilike."${pattern}"`,
    );
  }

  const { data, error } = await query;

  if (error) {
    throw new RoomQueryError(error.message);
  }

  return (data ?? []).map((row) => toPublicRoom(row as Record<string, unknown>));
}

/**
 * The caller's own membership for each listed room, as `owner` or `student`.
 * `room_members` only grants SELECT through `room_members_select_own`, so this
 * returns the viewer's rows and nobody else's — a student can never learn who
 * else is in a room from it. Rooms the caller is not a member of are simply
 * absent, which the caller maps to `none`.
 */
export async function listViewerMemberships(
  client: SupabaseClient,
  roomIds: string[],
): Promise<Map<string, "owner" | "student">> {
  const memberships = new Map<string, "owner" | "student">();
  if (roomIds.length === 0) {
    return memberships;
  }

  const { data, error } = await client
    .from("room_members")
    .select("room_id, role")
    .in("room_id", roomIds);

  if (error) {
    throw new RoomQueryError(error.message);
  }

  for (const row of data ?? []) {
    const record = row as { room_id?: unknown; role?: unknown };
    if (typeof record.room_id === "string") {
      memberships.set(
        record.room_id,
        record.role === "owner" ? "owner" : "student",
      );
    }
  }

  return memberships;
}

/**
 * Aggregate seat usage per public room, from the `public_room_member_counts`
 * RPC. The function only ever returns `room_id` and a count for rooms with
 * `visibility = 'public'`, so private-room occupancy cannot be observed and no
 * participant identity is included. Unknown rooms are reported as 0.
 */
export async function roomMemberCounts(
  client: SupabaseClient,
): Promise<Map<string, number>> {
  const { data, error } = await client.rpc("public_room_member_counts");

  if (error) {
    throw new RoomQueryError(error.message);
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { room_id?: unknown; member_count?: unknown }[]) {
    if (typeof row.room_id === "string") {
      const count = Number(row.member_count);
      counts.set(row.room_id, Number.isFinite(count) ? count : 0);
    }
  }
  return counts;
}
