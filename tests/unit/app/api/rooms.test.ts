import { GET, POST } from "@/app/api/rooms/route";
import { RoomError } from "@/lib/rooms/create";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, listPublicRooms, getProfile, createRoom } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    listPublicRooms: vi.fn(),
    getProfile: vi.fn(),
    createRoom: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/queries")>()),
  listPublicRooms,
}));

vi.mock("@/lib/profiles/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/queries")>()),
  getProfile,
}));

vi.mock("@/lib/rooms/create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/create")>()),
  createRoom,
}));

const room = {
  id: "room-1",
  name: "Calculus Study Room",
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  capacity: 6,
  status: "open",
  shared_goal: "Finish the syllabus",
  created_at: "2026-10-06T00:00:00.000Z",
};

function getRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function postRequest(body: string) {
  return new NextRequest("http://localhost:3000/api/rooms", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/rooms", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    listPublicRooms.mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) },
    });
    expect(listPublicRooms).not.toHaveBeenCalled();
  });

  it("returns the shaped public rooms", async () => {
    listPublicRooms.mockResolvedValue([room]);

    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rooms: [room] });
    expect(listPublicRooms).toHaveBeenCalledWith(expect.anything(), { q: "" });
  });

  it("forwards the search query", async () => {
    await GET(getRequest("/api/rooms?q=calculus"));

    expect(listPublicRooms).toHaveBeenCalledWith(expect.anything(), {
      q: "calculus",
    });
  });

  it("rejects an over-long query with 400", async () => {
    const response = await GET(getRequest(`/api/rooms?q=${"a".repeat(101)}`));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues[0].path).toBe("q");
    expect(listPublicRooms).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    listPublicRooms.mockRejectedValue(new Error("connection lost"));

    const response = await GET(getRequest("/api/rooms"));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
  });
});

describe("POST /api/rooms", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    getProfile.mockResolvedValue({ id: "user-1", alias: "examnerd" });
    createRoom.mockResolvedValue(room);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(401);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON with 400", async () => {
    const response = await POST(postRequest("{not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("rejects invalid room fields with 400 and lists the issues", async () => {
    const response = await POST(postRequest(JSON.stringify({ capacity: 0 })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(
      ["name", "capacity"],
    );
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("requires an onboarding alias with 403", async () => {
    getProfile.mockResolvedValue(null);

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("onboarding_required");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("creates the room from validated input only", async () => {
    const response = await POST(
      postRequest(
        JSON.stringify({
          name: "  Calculus Study Room  ",
          capacity: "6",
          subject: "Mathematics",
          owner_id: "someone-else",
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ room });
    expect(createRoom).toHaveBeenCalledWith(expect.anything(), {
      name: "Calculus Study Room",
      capacity: 6,
      visibility: "public",
      exam_track: null,
      subject: "Mathematics",
      language: null,
      shared_goal: null,
      status: "open",
    });
  });

  it("maps RoomError onto its status and code", async () => {
    createRoom.mockRejectedValue(
      new RoomError(
        "permission_denied",
        "You do not have permission to create this room.",
        403,
      ),
    );

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "permission_denied",
        message: "You do not have permission to create this room.",
      },
    });
  });

  it("returns 500 for an unexpected create failure", async () => {
    createRoom.mockRejectedValue(new Error("boom"));

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("rpc_failed");
  });

  it("returns 500 when the profile lookup fails", async () => {
    getProfile.mockRejectedValue(new Error("connection lost"));

    const response = await POST(postRequest(JSON.stringify({ name: "Room" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
    expect(createRoom).not.toHaveBeenCalled();
  });
});
