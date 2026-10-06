import { GET, POST } from "@/app/api/rooms/[id]/goals/route";
import { GoalError } from "@/lib/goals/queries";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  requireRoomMembership,
  listGoals,
  createGoal,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  requireRoomMembership: vi.fn(),
  listGoals: vi.fn(),
  createGoal: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));

vi.mock("@/lib/goals/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/goals/queries")>()),
  listGoals,
  createGoal,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const goal = {
  id: "44444444-4444-4444-8444-444444444444",
  room_id: ROOM_ID,
  title: "Finish chapter 4",
  target_seconds: 1500,
  target_count: null,
  status: "active",
  completed_at: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
};

function request(method: "GET" | "POST", body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/goals`, {
      method,
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("GET /api/rooms/[id]/goals", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    requireRoomMembership.mockResolvedValue(undefined);
    listGoals.mockResolvedValue([goal]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request: req, context } = request("GET");
    const response = await GET(req, context);

    expect(response.status).toBe(401);
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request: req, context } = request("GET", undefined, "not-a-uuid");
    const response = await GET(req, context);

    expect(response.status).toBe(400);
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("answers 404 before reading goals for a non-member", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const { request: req, context } = request("GET");
    const response = await GET(req, context);

    expect(response.status).toBe(404);
    expect(listGoals).not.toHaveBeenCalled();
  });

  it("returns the caller's goals for a member", async () => {
    const { request: req, context } = request("GET");
    const response = await GET(req, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ goals: [goal] });
    expect(requireRoomMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
    );
    expect(listGoals).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
  });

  it("returns 500 without leaking the failure detail", async () => {
    listGoals.mockRejectedValue(new Error('relation "public.study_goals" is locked'));

    const { request: req, context } = request("GET");
    const response = await GET(req, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("goals_failed");
    expect(JSON.stringify(body)).not.toContain("study_goals");
  });
});

describe("POST /api/rooms/[id]/goals", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    requireRoomMembership.mockResolvedValue(undefined);
    createGoal.mockResolvedValue(goal);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request: req, context } = request("POST", JSON.stringify({ title: "Read" }));
    const response = await POST(req, context);

    expect(response.status).toBe(401);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("requires a session sub before touching the database", async () => {
    getClaims.mockResolvedValue({ data: { claims: {} } });

    const { request: req, context } = request("POST", JSON.stringify({ title: "Read" }));
    const response = await POST(req, context);

    expect(response.status).toBe(401);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const { request: req, context } = request("POST", "{not json");
    const response = await POST(req, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it.each([
    ["blank title", { title: "   " }],
    ["missing title", {}],
    ["target out of range", { title: "Read", target_seconds: 30 }],
    ["unknown field", { title: "Read", user_id: "someone" }],
  ])("rejects %s with a validation error", async (_label, body) => {
    const { request: req, context } = request("POST", JSON.stringify(body));
    const response = await POST(req, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("answers 201 with the created goal, taking the user id from the session", async () => {
    const { request: req, context } = request(
      "POST",
      JSON.stringify({ title: "Finish chapter 4", target_seconds: 1500 }),
    );
    const response = await POST(req, context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ goal });
    expect(requireRoomMembership).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    expect(createGoal).toHaveBeenCalledWith(expect.anything(), {
      roomId: ROOM_ID,
      userId: "user-1",
      title: "Finish chapter 4",
      targetSeconds: 1500,
      targetCount: undefined,
    });
  });

  it("answers 404 when the room is not the caller's", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const { request: req, context } = request("POST", JSON.stringify({ title: "Read" }));
    const response = await POST(req, context);

    expect(response.status).toBe(404);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("answers 409 for a duplicate active title", async () => {
    createGoal.mockRejectedValue(
      new GoalError(
        "duplicate_goal",
        "You already have an active goal with that title in this room.",
        409,
      ),
    );

    const { request: req, context } = request("POST", JSON.stringify({ title: "Read" }));
    const response = await POST(req, context);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("duplicate_goal");
  });

  it("returns 500 without leaking the failure detail", async () => {
    createGoal.mockRejectedValue(new Error('relation "public.study_goals" is locked'));

    const { request: req, context } = request("POST", JSON.stringify({ title: "Read" }));
    const response = await POST(req, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("goal_create_failed");
    expect(JSON.stringify(body)).not.toContain("study_goals");
  });
});
