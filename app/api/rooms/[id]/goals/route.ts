import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { createGoal, GoalError, listGoals } from "@/lib/goals/queries";
import { RoomAccessError, requireRoomMembership } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { createGoalSchema } from "@/lib/validation/goals";
import { roomIdSchema } from "@/lib/validation/rooms";

type GoalsContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/goals — the caller's own goals in one room.
 *
 * Membership is confirmed first so a non-member gets the same 404 the
 * workspace gives, and RLS narrows the rows to the caller: an empty list is
 * "you have none here", never another member's titles.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "goals": [...] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "goals_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: GoalsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view your goals.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const goals = await listGoals(supabase, parsedRoomId.data);
    return NextResponse.json({ goals });
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/goals] list failed:", error);
    return errorResponse(
      "goals_failed",
      "Your goals could not be loaded.",
      500,
    );
  }
}

/**
 * POST /api/rooms/[id]/goals — create one of the caller's own goals.
 *
 * The user id is never taken from the body: it comes from the verified session
 * claims, and `study_goals_insert_own` checks the same identity again, so a
 * forged `user_id` or a room the caller does not belong to cannot be written.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "goal": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "duplicate_goal" } }` |
 * | 500 | `{ "error": { "code": "goal_create_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: GoalsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to add a goal.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
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

  const parsedGoal = createGoalSchema.safeParse(parsedBody.body);
  if (!parsedGoal.success) {
    return validationResponse(parsedGoal.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const goal = await createGoal(supabase, {
      roomId: parsedRoomId.data,
      userId: claims.sub,
      title: parsedGoal.data.title,
      targetSeconds: parsedGoal.data.target_seconds,
      targetCount: parsedGoal.data.target_count,
    });
    return NextResponse.json({ goal }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof GoalError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/goals] create failed:", error);
    return errorResponse(
      "goal_create_failed",
      "The goal could not be saved. Please try again.",
      500,
    );
  }
}
