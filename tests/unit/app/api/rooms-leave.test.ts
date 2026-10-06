import { POST } from "@/app/api/rooms/[id]/leave/route";
import { MembershipError } from "@/lib/rooms/membership";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, leaveRoom } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  leaveRoom: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/membership")>()),
  leaveRoom,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function post(body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/leave`, {
      method: "POST",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("POST /api/rooms/[id]/leave", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    leaveRoom.mockResolvedValue({ membership: "left", member_count: 1 });
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
    expect(leaveRoom).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = post("{}", "nope");

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(leaveRoom).not.toHaveBeenCalled();
  });

  it("refuses a body that carries a user id", async () => {
    const { request, context } = post(JSON.stringify({ user_id: "someone" }));

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(leaveRoom).not.toHaveBeenCalled();
  });

  it("answers 200 with the membership and the remaining seat count", async () => {
    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      membership: "left",
      member_count: 1,
    });
    expect(leaveRoom).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
  });

  it("returns a null member_count for a private room", async () => {
    leaveRoom.mockResolvedValue({ membership: "left", member_count: null });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      membership: "left",
      member_count: null,
    });
  });

  it.each([
    [new MembershipError("not_found", "That room does not exist or is not available.", 404), 404, "not_found"],
    [new MembershipError("owner_cannot_leave", "You own this room.", 409), 409, "owner_cannot_leave"],
    [new MembershipError("not_a_member", "You are not a member of this room.", 409), 409, "not_a_member"],
  ])("maps %s to %d", async (error, status, code) => {
    leaveRoom.mockRejectedValue(error);

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("returns 500 without leaking the failure detail", async () => {
    leaveRoom.mockRejectedValue(new Error("permission denied for table room_members"));

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("leave_failed");
    expect(JSON.stringify(body)).not.toContain("room_members");
  });
});
