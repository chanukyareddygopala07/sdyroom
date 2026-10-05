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
