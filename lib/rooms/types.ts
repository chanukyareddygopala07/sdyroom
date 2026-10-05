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
