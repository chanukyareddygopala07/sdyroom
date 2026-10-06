export type PublicRoom = {
  id: string;
  name: string;
  exam_track: string | null;
  subject: string | null;
  language: string | null;
  capacity: number;
  status: string;
  shared_goal: string | null;
  created_at: string;
};

/**
 * Explicit column list. Never use `SELECT *` here: it would drag owner ids and
 * any future private column straight into public responses.
 */
export const PUBLIC_ROOM_COLUMNS =
  "id, name, exam_track, subject, language, capacity, status, shared_goal, created_at";

export const PUBLIC_ROOM_LIMIT = 50;

/**
 * The caller's own relationship to a room, never anyone else's. Derived from
 * `room_members` through RLS (`room_members_select_own`), so a student only
 * ever learns their own membership and role.
 */
export type ViewerMembership = "none" | "member" | "owner";

/**
 * What `/rooms` renders. `member_count` is the aggregate seat usage returned
 * for public rooms only — no participant identities, emails or private-room
 * counts are ever attached to it.
 */
export type RoomSummary = PublicRoom & {
  member_count: number;
  viewer_membership: ViewerMembership;
};
