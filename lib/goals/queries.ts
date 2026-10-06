import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STUDY_GOAL_COLUMNS,
  type StudyGoal,
  type StudyGoalStatus,
} from "./types";

export type GoalErrorCode = "not_found" | "duplicate_goal";

/** Failure carrying the HTTP status the API layer returns. */
export class GoalError extends Error {
  readonly code: GoalErrorCode;
  readonly status: number;

  constructor(code: GoalErrorCode, message: string, status: number) {
    super(message);
    this.name = "GoalError";
    this.code = code;
    this.status = status;
  }
}

const NOT_FOUND_MESSAGE =
  "That goal does not exist or is not available.";
const DUPLICATE_MESSAGE =
  "You already have an active goal with that title in this room.";

function envelopeOf(data: unknown): Record<string, unknown> | null {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/** Parses a goal row onto the exposed shape, or throws on malformed data. */
export function toStudyGoal(value: unknown): StudyGoal {
  const row = envelopeOf(value);
  if (!row) {
    throw new Error("Missing study goal payload.");
  }

  const id = row.id;
  const roomId = row.room_id;
  const title = row.title;
  const targetSeconds = row.target_seconds;
  const targetCount = row.target_count;
  const status = row.status;
  const completedAt = row.completed_at;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  if (
    typeof id !== "string" ||
    typeof roomId !== "string" ||
    typeof title !== "string" ||
    !((targetSeconds === null || typeof targetSeconds === "number")) ||
    !((targetCount === null || typeof targetCount === "number")) ||
    (status !== "active" && status !== "completed") ||
    !((completedAt === null || typeof completedAt === "string")) ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error(
      `Unexpected study goal payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  // The `study_goals_completed_fields` CHECK: a goal is completed exactly
  // while it carries a completion timestamp.
  if ((status === "completed") !== (completedAt !== null)) {
    throw new Error(
      `Unexpected study goal payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  return {
    id,
    room_id: roomId,
    title,
    target_seconds: targetSeconds,
    target_count: targetCount,
    status,
    completed_at: completedAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * The caller's own goals in one room, newest first. RLS
 * (`study_goals_select_own`) narrows the rows to the caller, so an empty list
 * means "you have none here" — never someone else's titles.
 */
export async function listGoals(
  client: SupabaseClient,
  roomId: string,
): Promise<StudyGoal[]> {
  const { data, error } = await client
    .from("study_goals")
    .select(STUDY_GOAL_COLUMNS)
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`listGoals failed: ${error.message}`);
  }

  return (data ?? []).map((row) => toStudyGoal(row));
}

export type CreateGoalInput = {
  roomId: string;
  /** From the verified session claims — the same identity RLS checks. */
  userId: string;
  title: string;
  targetSeconds?: number | null;
  targetCount?: number | null;
};

/**
 * Creates a goal for the caller. Two failures are mapped rather than thrown
 * raw: `23505` is the partial unique index on active titles, and `42501` /
 * `23503` mean the room is not one the caller belongs to (or does not exist),
 * which is reported as the same 404 the workspace uses.
 */
export async function createGoal(
  client: SupabaseClient,
  input: CreateGoalInput,
): Promise<StudyGoal> {
  const { data, error } = await client
    .from("study_goals")
    .insert({
      user_id: input.userId,
      room_id: input.roomId,
      title: input.title,
      target_seconds: input.targetSeconds ?? null,
      target_count: input.targetCount ?? null,
    })
    .select(STUDY_GOAL_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new GoalError("duplicate_goal", DUPLICATE_MESSAGE, 409);
    }
    if (error.code === "42501" || error.code === "23503") {
      throw new GoalError("not_found", NOT_FOUND_MESSAGE, 404);
    }
    throw new Error(`createGoal failed: ${error.message}`);
  }

  return toStudyGoal(data);
}

export type UpdateGoalInput = {
  title?: string;
  targetSeconds?: number | null;
  targetCount?: number | null;
  status?: StudyGoalStatus;
};

/**
 * Updates the caller's own goal. Only the four client-editable columns are
 * ever sent — `completed_at` and `updated_at` are written by the trigger, and
 * the column grants reject anything else outright. Zero rows means the goal is
 * not the caller's (or is gone), which is the same 404.
 */
export async function updateGoal(
  client: SupabaseClient,
  goalId: string,
  patch: UpdateGoalInput,
): Promise<StudyGoal> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.targetSeconds !== undefined) row.target_seconds = patch.targetSeconds;
  if (patch.targetCount !== undefined) row.target_count = patch.targetCount;
  if (patch.status !== undefined) row.status = patch.status;

  const { data, error } = await client
    .from("study_goals")
    .update(row)
    .eq("id", goalId)
    .select(STUDY_GOAL_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "42501") {
      throw new GoalError("not_found", NOT_FOUND_MESSAGE, 404);
    }
    throw new Error(`updateGoal failed: ${error.message}`);
  }

  if (!data) {
    throw new GoalError("not_found", NOT_FOUND_MESSAGE, 404);
  }

  return toStudyGoal(data);
}

/** Deletes the caller's own goal; another user's row is simply not matched. */
export async function deleteGoal(
  client: SupabaseClient,
  goalId: string,
): Promise<void> {
  const { data, error } = await client
    .from("study_goals")
    .delete()
    .eq("id", goalId)
    .select("id");

  if (error) {
    if (error.code === "42501") {
      throw new GoalError("not_found", NOT_FOUND_MESSAGE, 404);
    }
    throw new Error(`deleteGoal failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new GoalError("not_found", NOT_FOUND_MESSAGE, 404);
  }
}
