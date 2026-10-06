import { POST } from "@/app/api/rooms/[id]/join/route";
import { MembershipError } from "@/lib/rooms/membership";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, joinRoom } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  joinRoom: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/membership")>()),
  joinRoom,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function post(body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/join`, {
      method: "POST",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("POST /api/rooms/[id]/join", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    joinRoom.mockResolvedValue({ membership: "joined", member_count: 2 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const { request, context } = post("{}");

    const response = await POST(request, context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) },
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = post("{}", "not-a-uuid");

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const { request, context } = post("{not json");

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("rejects a body that is not an object", async () => {
    const { request, context } = post("[]");

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("refuses identity supplied in the body instead of ignoring it", async () => {
    const { request, context } = post(JSON.stringify({ user_id: "someone" }));

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues).toEqual([
      { path: "user_id", message: "Not accepted here." },
    ]);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("accepts an absent body and an empty object", async () => {
    for (const body of [undefined, "{}"]) {
      const { request, context } = post(body);

      const response = await POST(request, context);

      expect(response.status).toBe(201);
      expect(joinRoom).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    }
  });

  it("answers 201 with the membership and seat count for a new join", async () => {
    joinRoom.mockResolvedValue({ membership: "joined", member_count: 5 });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      membership: "joined",
      member_count: 5,
    });
  });

  it("answers 200 for an idempotent repeat", async () => {
    joinRoom.mockResolvedValue({ membership: "already_member", member_count: 5 });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      membership: "already_member",
      member_count: 5,
    });
  });

  it.each([
    [new MembershipError("not_found", "That room does not exist or is not available.", 404), 404, "not_found"],
    [new MembershipError("room_full", "This room is full.", 409), 409, "room_full"],
    [new MembershipError("room_closed", "This room is closed.", 409), 409, "room_closed"],
  ])("maps %s to %d", async (error, status, code) => {
    joinRoom.mockRejectedValue(error);

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("returns 500 without leaking the failure detail", async () => {
    joinRoom.mockRejectedValue(new Error("relation \"public.room_members\" is locked"));

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("join_failed");
    expect(JSON.stringify(body)).not.toContain("room_members");
  });
});
