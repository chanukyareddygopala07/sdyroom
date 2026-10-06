import { POST as pause } from "@/app/api/rooms/[id]/session/pause/route";
import { POST as resume } from "@/app/api/rooms/[id]/session/resume/route";
import { POST as end } from "@/app/api/rooms/[id]/session/end/route";
import { FocusSessionError } from "@/lib/focus/sessions";
import { NextRequest, type NextRequest as NextRequestType } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, pauseFocusSession, resumeFocusSession, endFocusSession } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    pauseFocusSession: vi.fn(),
    resumeFocusSession: vi.fn(),
    endFocusSession: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/focus/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/focus/sessions")>()),
  pauseFocusSession,
  resumeFocusSession,
  endFocusSession,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const pausedSession = {
  id: "22222222-2222-4222-8222-222222222222",
  room_id: ROOM_ID,
  state: "paused",
  duration_seconds: 1500,
  started_at: "2026-10-06T07:00:00+00:00",
  ends_at: "2026-10-06T07:25:00+00:00",
  paused_at: "2026-10-06T07:10:00+00:00",
  paused_seconds: 0,
  ended_at: null,
};

type Control = {
  label: string;
  path: string;
  call: (
    request: NextRequestType,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  mock: ReturnType<typeof vi.fn>;
  action: string;
  failureCode: string;
};

function controls(): Control[] {
  return [
    {
      label: "pause",
      path: "pause",
      call: pause as unknown as Control["call"],
      mock: pauseFocusSession,
      action: "paused",
      failureCode: "pause_failed",
    },
    {
      label: "resume",
      path: "resume",
      call: resume as unknown as Control["call"],
      mock: resumeFocusSession,
      action: "resumed",
      failureCode: "resume_failed",
    },
    {
      label: "end",
      path: "end",
      call: end as unknown as Control["call"],
      mock: endFocusSession,
      action: "completed",
      failureCode: "end_failed",
    },
  ];
}

function post(path: string, body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(
      `http://localhost:3000/api/rooms/${id}/session/${path}`,
      {
        method: "POST",
        body,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
      },
    ),
    context: { params: Promise.resolve({ id }) },
  };
}

describe.each(controls())("POST /api/rooms/[id]/session/$path", (control) => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    control.mock.mockResolvedValue({
      action: control.action,
      session: pausedSession,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = post(control.path, "{}");
    const response = await control.call(request, context);

    expect(response.status).toBe(401);
    expect(control.mock).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = post(control.path, "{}", "not-a-uuid");
    const response = await control.call(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("rejects any field in the body instead of ignoring it", async () => {
    const { request, context } = post(
      control.path,
      JSON.stringify({ forced: true }),
    );
    const response = await control.call(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues).toEqual([
      { path: "forced", message: "Not accepted here." },
    ]);
    expect(control.mock).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const { request, context } = post(control.path, "{not json");
    const response = await control.call(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("accepts an absent body and an empty object", async () => {
    for (const body of [undefined, "{}"]) {
      const { request, context } = post(control.path, body);
      const response = await control.call(request, context);

      expect(response.status).toBe(200);
      expect(control.mock).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    }
  });

  it("answers 200 with the action and the session", async () => {
    const { request, context } = post(control.path, "{}");
    const response = await control.call(request, context);

    expect(await response.json()).toEqual({
      action: control.action,
      session: pausedSession,
    });
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
    [
      new FocusSessionError(
        "no_active_session",
        "There is no active focus session in this room.",
        409,
      ),
      409,
      "no_active_session",
    ],
    [
      new FocusSessionError(
        "invalid_state",
        "The focus session is not in a state that allows this.",
        409,
      ),
      409,
      "invalid_state",
    ],
  ])("maps the session failure to %d", async (error, status, code) => {
    control.mock.mockRejectedValue(error);

    const { request, context } = post(control.path, "{}");
    const response = await control.call(request, context);

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("returns 500 without leaking the failure detail", async () => {
    control.mock.mockRejectedValue(
      new Error('relation "public.focus_sessions" is locked'),
    );

    const { request, context } = post(control.path, "{}");
    const response = await control.call(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe(control.failureCode);
    expect(JSON.stringify(body)).not.toContain("focus_sessions");
  });
});
