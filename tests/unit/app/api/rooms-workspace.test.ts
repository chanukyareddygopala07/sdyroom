import { GET } from "@/app/api/rooms/[id]/workspace/route";
import { FocusSessionError } from "@/lib/focus/sessions";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, getFocusWorkspace } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  getFocusWorkspace: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/focus/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/focus/workspace")>()),
  getFocusWorkspace,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function get(id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/workspace`),
    context: { params: Promise.resolve({ id }) },
  };
}

const workspace = {
  room: { id: ROOM_ID, name: "Physics sprint" },
  session: null,
  viewer_role: "owner",
  server_now_ms: 1791298800000,
  member_count: 2,
  history: [],
};

describe("GET /api/rooms/[id]/workspace", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    getFocusWorkspace.mockResolvedValue(workspace);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = get();
    const response = await GET(request, context);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(getFocusWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = get("not-a-uuid");
    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(getFocusWorkspace).not.toHaveBeenCalled();
  });

  it("returns the workspace for a member", async () => {
    const { request, context } = get();
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(workspace);
    expect(getFocusWorkspace).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
  });

  it("answers 404 for a non-member and a missing room alike", async () => {
    getFocusWorkspace.mockRejectedValue(
      new FocusSessionError(
        "not_found",
        "That room does not exist or is not available.",
        404,
      ),
    );

    const { request, context } = get();
    const response = await GET(request, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
    expect(JSON.stringify(body)).not.toContain("rooms");
  });

  it("returns 500 without leaking the failure detail", async () => {
    getFocusWorkspace.mockRejectedValue(
      new Error('relation "public.focus_sessions" is locked'),
    );

    const { request, context } = get();
    const response = await GET(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("workspace_failed");
    expect(JSON.stringify(body)).not.toContain("focus_sessions");
  });
});
