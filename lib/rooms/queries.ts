import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomSearchInput } from "@/lib/validation/rooms";
import { toPublicRoom } from "./shape";
import { PUBLIC_ROOM_COLUMNS, PUBLIC_ROOM_LIMIT, type PublicRoom } from "./types";

export class RoomQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomQueryError";
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
