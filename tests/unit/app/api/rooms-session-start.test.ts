import { POST } from "@/app/api/rooms/[id]/session/start/route";
import { FocusSessionError } from "@/lib/focus/sessions";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, startFocusSession } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  startFocusSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/focus/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/focus/sessions")>()),
  startFocusSession,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const session = {
  id: "22222222-2222-4222-8222-222222222222",
  room_id: ROOM_ID,
  state: "running",
  duration_seconds: 1500,
  started_at: "2026-10-06T07:00:00+00:00",
  ends_at: "2026-10-06T07:25:00+00:00",
  paused_at: null,
  paused_seconds: 0,
  ended_at: null,
};

function post(body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/session/start`, {
      method: "POST",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("POST /api/rooms/[id]/session/start", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    startFocusSession.mockResolvedValue({ action: "started", session });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(startFocusSession).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = post("{}", "not-a-uuid");
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("rejects a body that is not JSON", async () => {
    const { request, context } = post("{not json");
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it.each([
    ["missing duration", "{}"],
    ["too short", JSON.stringify({ duration_seconds: 30 })],
    ["too long", JSON.stringify({ duration_seconds: 100000 })],
    ["fractional", JSON.stringify({ duration_seconds: 1500.5 })],
    [
      "unknown field",
      JSON.stringify({ duration_seconds: 1500, user_id: "someone" }),
    ],
    ["array body", "[]"],
  ])("rejects %s with a validation error", async (_label, body) => {
    const { request, context } = post(body);
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(startFocusSession).not.toHaveBeenCalled();
  });

  it("answers 201 with the started session", async () => {
    const { request, context } = post(JSON.stringify({ duration_seconds: 1500 }));
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ action: "started", session });
    expect(startFocusSession).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
      1500,
    );
  });

  it("answers 200 when a session is already running", async () => {
    startFocusSession.mockResolvedValue({ action: "already_active", session });

    const { request, context } = post(JSON.stringify({ duration_seconds: 600 }));
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("already_active");
  });

  it.each([
    [new FocusSessionError("not_owner", "Only the room owner can control this room's focus timer.", 403), 403, "not_owner"],
    [
      new FocusSessionError(
        "not_found",
        "That room does not exist or is not available.",
        404,
      ),
      404,
      "not_found",
    ],
    [new FocusSessionError("invalid", "Focus duration must be between 60 and 7200 seconds.", 400), 400, "invalid"],
  ])("maps %s to %d", async (error, status, code) => {
    startFocusSession.mockRejectedValue(error);

    const { request, context } = post(JSON.stringify({ duration_seconds: 60 }));
    const response = await POST(request, context);

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("returns 500 without leaking the failure detail", async () => {
    startFocusSession.mockRejectedValue(
      new Error('relation "public.focus_sessions" is locked'),
    );

    const { request, context } = post(JSON.stringify({ duration_seconds: 60 }));
    const response = await POST(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("start_failed");
    expect(JSON.stringify(body)).not.toContain("focus_sessions");
  });
});
