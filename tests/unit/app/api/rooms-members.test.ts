import { GET } from "@/app/api/rooms/[id]/members/route";
import {
  RosterDeniedError,
} from "@/lib/invitations/queries";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  requireRoomMembership: membership,
  roomRoster,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  requireRoomMembership: vi.fn(),
  roomRoster: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership: membership,
}));

vi.mock("@/lib/invitations/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invitations/queries")>()),
  roomRoster,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function get(id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/members`),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("GET /api/rooms/[id]/members", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    membership.mockResolvedValue(undefined);
    roomRoster.mockResolvedValue([
      { alias: "owneralias", role: "owner", joined_at: "2026-10-07T10:00:00.000Z" },
      { alias: "studybuddy", role: "student", joined_at: "2026-10-08T10:00:00.000Z" },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const { request, context } = get();

    const response = await GET(request, context);

    expect(response.status).toBe(401);
    expect(roomRoster).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = get("not-a-uuid");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(membership).not.toHaveBeenCalled();
  });

  it("answers 200 with alias, role and joined_at only", async () => {
    const { request, context } = get();

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      members: [
        {
          alias: "owneralias",
          role: "owner",
          joined_at: "2026-10-07T10:00:00.000Z",
        },
        {
          alias: "studybuddy",
          role: "student",
          joined_at: "2026-10-08T10:00:00.000Z",
        },
      ],
      count: 2,
    });
    // The roster is display data: no identifiers ever ride along.
    expect(JSON.stringify(body)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(membership).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    expect(roomRoster).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
  });

  it("maps a non-member and a lost seat to the same 404", async () => {
    membership.mockRejectedValueOnce(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const nonMember = get();
    const first = await GET(nonMember.request, nonMember.context);
    expect(first.status).toBe(404);
    expect((await first.json()).error.code).toBe("not_found");
    expect(roomRoster).not.toHaveBeenCalled();

    roomRoster.mockRejectedValueOnce(new RosterDeniedError());
    const lost = get();
    const second = await GET(lost.request, lost.context);
    expect(second.status).toBe(404);
    expect((await second.json()).error.code).toBe("not_found");
  });

  it("returns 500 when the roster fails for another reason", async () => {
    roomRoster.mockRejectedValue(new Error("connection reset"));
    const { request, context } = get();

    const response = await GET(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("members_failed");
    expect(JSON.stringify(body)).not.toContain("connection reset");
  });
});
