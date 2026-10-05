import type { PublicRoom } from "./types";

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Maps a `public.rooms` row onto the public response shape. Only the listed
 * fields survive, so anything else on the row (owner id, visibility flags,
 * future private columns) can never leak into an API or page response.
 */
export function toPublicRoom(row: Record<string, unknown>): PublicRoom {
  return {
    id: text(row.id),
    name: text(row.name),
    exam_track: textOrNull(row.exam_track),
    subject: textOrNull(row.subject),
    language: textOrNull(row.language),
    capacity: count(row.capacity),
    status: text(row.status),
    shared_goal: textOrNull(row.shared_goal),
    created_at: text(row.created_at),
  };
}
