import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { deleteGoal, GoalError, updateGoal } from "@/lib/goals/queries";
import { createClient } from "@/lib/supabase/server";
import { updateGoalSchema } from "@/lib/validation/goals";
import { z } from "zod";

type GoalItemContext = { params: Promise<{ goalId: string }> };

const goalIdSchema = z.uuid();

/**
 * PATCH /api/goals/[goalId] — edit one of the caller's own goals.
 *
 * Only the client-editable fields are addressable: `completed_at` and
 * `updated_at` belong to the database trigger, and the column grants reject
 * them outright. Zero rows updated means the goal is not the caller's (or no
 * longer exists), which is the same 404.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "goal": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "duplicate_goal" } }` |
 * | 500 | `{ "error": { "code": "goal_update_failed" } }` |
 */
export async function PATCH(request: NextRequest, { params }: GoalItemContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to edit your goal.", 401);
  }

  const { goalId } = await params;
  const parsedGoalId = goalIdSchema.safeParse(goalId);
  if (!parsedGoalId.success) {
    return errorResponse("validation", "That goal id is not valid.", 400, [
      { path: "goalId", message: "Goal id must be a UUID." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse(
      "invalid_json",
      "The request body must be JSON.",
      400,
    );
  }

  const parsedUpdate = updateGoalSchema.safeParse(parsedBody.body);
  if (!parsedUpdate.success) {
    return validationResponse(parsedUpdate.error);
  }

  if (Object.keys(parsedUpdate.data).length === 0) {
    return errorResponse(
      "invalid_request",
      "Provide at least one field to update.",
      400,
    );
  }

  try {
    const goal = await updateGoal(supabase, parsedGoalId.data, {
      title: parsedUpdate.data.title,
      targetSeconds: parsedUpdate.data.target_seconds,
      targetCount: parsedUpdate.data.target_count,
      status: parsedUpdate.data.status,
    });
    return NextResponse.json({ goal });
  } catch (error) {
    if (error instanceof GoalError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/goals] update failed:", error);
    return errorResponse(
      "goal_update_failed",
      "The goal could not be updated. Please try again.",
      500,
    );
  }
}

/**
 * DELETE /api/goals/[goalId] — remove one of the caller's own goals.
 *
 * Another member's goal simply does not match the caller's rows, so the
 * endpoint reports the same 404 it would for an id that never existed.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "deleted": true }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "goal_delete_failed" } }` |
 */
export async function DELETE(
  request: NextRequest,
  { params }: GoalItemContext,
) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to delete your goal.", 401);
  }

  const { goalId } = await params;
  const parsedGoalId = goalIdSchema.safeParse(goalId);
  if (!parsedGoalId.success) {
    return errorResponse("validation", "That goal id is not valid.", 400, [
      { path: "goalId", message: "Goal id must be a UUID." },
    ]);
  }

  try {
    await deleteGoal(supabase, parsedGoalId.data);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof GoalError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/goals] delete failed:", error);
    return errorResponse(
      "goal_delete_failed",
      "The goal could not be deleted. Please try again.",
      500,
    );
  }
}
