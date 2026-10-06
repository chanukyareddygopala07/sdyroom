import { DELETE, PATCH } from "@/app/api/goals/[goalId]/route";
import { GoalError } from "@/lib/goals/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, updateGoal, deleteGoal } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/goals/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/goals/queries")>()),
  updateGoal,
  deleteGoal,
}));

const GOAL_ID = "44444444-4444-4444-8444-444444444444";

const goal = {
  id: GOAL_ID,
  room_id: "11111111-1111-4111-8111-111111111111",
  title: "Finish chapter 4",
  target_seconds: 1500,
  target_count: null,
  status: "completed",
  completed_at: "2026-10-06T08:00:00+00:00",
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T08:00:00+00:00",
};

function patch(body?: string, goalId: string = GOAL_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/goals/${goalId}`, {
      method: "PATCH",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ goalId }) },
  };
}

function remove(goalId: string = GOAL_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/goals/${goalId}`, {
      method: "DELETE",
    }),
    context: { params: Promise.resolve({ goalId }) },
  };
}

describe("PATCH /api/goals/[goalId]", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    updateGoal.mockResolvedValue(goal);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = patch(JSON.stringify({ status: "completed" }));
    const response = await PATCH(request, context);

    expect(response.status).toBe(401);
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("rejects a goal id that is not a UUID", async () => {
    const { request, context } = patch(JSON.stringify({ status: "completed" }), "not-a-uuid");
    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("rejects a body that is not JSON", async () => {
    const { request, context } = patch("{not json");
    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("rejects a body with no fields instead of doing nothing", async () => {
    const { request, context } = patch("{}");
    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("refuses fields the client may never write", async () => {
    const { request, context } = patch(
      JSON.stringify({ completed_at: "2020-01-01T00:00:00Z" }),
    );
    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it("answers 200 with the updated goal", async () => {
    const { request, context } = patch(JSON.stringify({ status: "completed" }));
    const response = await PATCH(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ goal });
    expect(updateGoal).toHaveBeenCalledWith(expect.anything(), GOAL_ID, {
      title: undefined,
      targetSeconds: undefined,
      targetCount: undefined,
      status: "completed",
    });
  });

  it("answers 404 for a goal that is not the caller's", async () => {
    updateGoal.mockRejectedValue(
      new GoalError(
        "not_found",
        "That goal does not exist or is not available.",
        404,
      ),
    );

    const { request, context } = patch(JSON.stringify({ status: "completed" }));
    const response = await PATCH(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("answers 409 for a duplicate active title", async () => {
    updateGoal.mockRejectedValue(
      new GoalError(
        "duplicate_goal",
        "You already have an active goal with that title in this room.",
        409,
      ),
    );

    const { request, context } = patch(JSON.stringify({ title: "Other" }));
    const response = await PATCH(request, context);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("duplicate_goal");
  });

  it("returns 500 without leaking the failure detail", async () => {
    updateGoal.mockRejectedValue(new Error('relation "public.study_goals" is locked'));

    const { request, context } = patch(JSON.stringify({ status: "completed" }));
    const response = await PATCH(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("goal_update_failed");
    expect(JSON.stringify(body)).not.toContain("study_goals");
  });
});

describe("DELETE /api/goals/[goalId]", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    deleteGoal.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(401);
    expect(deleteGoal).not.toHaveBeenCalled();
  });

  it("rejects a goal id that is not a UUID", async () => {
    const { request, context } = remove("not-a-uuid");
    const response = await DELETE(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("answers 200 when the caller's goal was deleted", async () => {
    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(deleteGoal).toHaveBeenCalledWith(expect.anything(), GOAL_ID);
  });

  it("answers 404 for a goal that is not the caller's", async () => {
    deleteGoal.mockRejectedValue(
      new GoalError(
        "not_found",
        "That goal does not exist or is not available.",
        404,
      ),
    );

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 500 without leaking the failure detail", async () => {
    deleteGoal.mockRejectedValue(new Error('relation "public.study_goals" is locked'));

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("goal_delete_failed");
    expect(JSON.stringify(body)).not.toContain("study_goals");
  });
});
