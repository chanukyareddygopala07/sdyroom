export type StudyGoalStatus = "active" | "completed";

/**
 * A personal goal for the caller in one room. RLS guarantees every row is the
 * viewer's own, and `user_id` is left out of the shape anyway: nobody else's
 * goals are ever readable, so there is nothing to compare it against.
 */
export type StudyGoal = {
  id: string;
  room_id: string;
  title: string;
  target_seconds: number | null;
  target_count: number | null;
  status: StudyGoalStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Explicit column list — never `SELECT *` (see PUBLIC_ROOM_COLUMNS). */
export const STUDY_GOAL_COLUMNS =
  "id, room_id, title, target_seconds, target_count, status, completed_at, created_at, updated_at";
