import { PATCH, DELETE } from "@/app/api/rooms/[id]/route";
import { ResourceError } from "@/lib/resources/queries";
import { RoomAccessError, RoomOwnerError } from "@/lib/rooms/access";
import { RoomMutationError } from "@/lib/rooms/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  requireRoomOwner,
  updateRoom,
  deleteRoom,
  removeRoomStorageObjects,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  requireRoomOwner: vi.fn(),
  updateRoom: vi.fn(),
  deleteRoom: vi.fn(),
  removeRoomStorageObjects: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomOwner,
}));

vi.mock("@/lib/rooms/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/queries")>()),
  updateRoom,
  deleteRoom,
}));

vi.mock("@/lib/resources/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/storage")>()),
  removeRoomStorageObjects,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const SAVED_ROOM = {
  id: ROOM_ID,
  name: "Renamed Room",
  exam_track: null,
  subject: null,
  language: null,
  capacity: 6,
  status: "open",
  shared_goal: null,
  created_at: "2026-10-01T00:00:00.000Z",
};

function patch(body: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}`, {
      method: "PATCH",
      body,
      headers: { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

function del(id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}`, {
      method: "DELETE",
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("PATCH /api/rooms/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    requireRoomOwner.mockResolvedValue(undefined);
    updateRoom.mockResolvedValue(SAVED_ROOM);
    deleteRoom.mockResolvedValue(undefined);
    removeRoomStorageObjects.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401 before anything else", async () => {
    getClaims.mockResolvedValue({ data: null });
    const { request, context } = patch(JSON.stringify({ name: "New" }));

    const response = await PATCH(request, context);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(requireRoomOwner).not.toHaveBeenCalled();
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = patch(JSON.stringify({ name: "New" }), "nope");

    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(requireRoomOwner).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const { request, context } = patch("{oops");

    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it("rejects an empty body with invalid_request, like the goals PATCH", async () => {
    const { request, context } = patch("{}");

    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(requireRoomOwner).not.toHaveBeenCalled();
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it("refuses identity and immutable fields with a field-named 400", async () => {
    for (const key of ["owner_id", "visibility", "created_at", "id"]) {
      const { request, context } = patch(
        JSON.stringify({ name: "New", [key]: "x" }),
      );

      const response = await PATCH(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("validation");
      // zod 4 strict issues name the offending key in `message`, with `path: ""`.
      expect(
        [body.error.issues?.[0]?.path, body.error.issues?.[0]?.message].join(
          " ",
        ),
      ).toContain(key);
      expect(updateRoom).not.toHaveBeenCalled();
    }
  });

  it("validates range and type before reaching the database", async () => {
    const { request, context } = patch(JSON.stringify({ capacity: 0 }));

    const response = await PATCH(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(requireRoomOwner).not.toHaveBeenCalled();
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-member, identical to a missing room", async () => {
    requireRoomOwner.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const { request, context } = patch(JSON.stringify({ name: "New" }));

    const response = await PATCH(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it("answers 403 for a member who is not the owner", async () => {
    requireRoomOwner.mockRejectedValue(
      new RoomOwnerError("Only the room owner can manage this room."),
    );
    const { request, context } = patch(JSON.stringify({ name: "New" }));

    const response = await PATCH(request, context);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("not_owner");
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it("passes the validated change set to updateRoom and returns the stored row", async () => {
    const { request, context } = patch(
      JSON.stringify({ name: "  Renamed  ", shared_goal: "" }),
    );

    const response = await PATCH(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: SAVED_ROOM });
    expect(requireRoomOwner).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    expect(updateRoom).toHaveBeenCalledWith(expect.anything(), ROOM_ID, {
      name: "Renamed",
      shared_goal: null,
    });
  });

  it("maps the capacity floor refusal to 409 with the database's count", async () => {
    updateRoom.mockRejectedValue(
      new RoomMutationError(
        "capacity_below_membership",
        "Capacity cannot be lower than the current member count (5).",
        409,
        5,
      ),
    );
    const { request, context } = patch(JSON.stringify({ capacity: 2 }));

    const response = await PATCH(request, context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("capacity_below_membership");
    expect(body.error.message).toContain("5");
  });

  it("returns 500 without leaking the database failure", async () => {
    updateRoom.mockRejectedValue(
      new Error('relation "public.rooms" is locked by some conflict'),
    );
    const { request, context } = patch(JSON.stringify({ name: "New" }));

    const response = await PATCH(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("room_update_failed");
    expect(JSON.stringify(body)).not.toContain("public.rooms");
  });
});

describe("DELETE /api/rooms/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    requireRoomOwner.mockResolvedValue(undefined);
    updateRoom.mockResolvedValue(SAVED_ROOM);
    deleteRoom.mockResolvedValue(undefined);
    removeRoomStorageObjects.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(401);
    expect(removeRoomStorageObjects).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    const { request, context } = del("nope");

    const response = await DELETE(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-member before any cleanup runs", async () => {
    requireRoomOwner.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect(removeRoomStorageObjects).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it("answers 403 for a member who is not the owner", async () => {
    requireRoomOwner.mockRejectedValue(
      new RoomOwnerError("Only the room owner can manage this room."),
    );
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("not_owner");
    expect(removeRoomStorageObjects).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it("sweeps storage before deleting the row and answers 200", async () => {
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    // Objects first, rows second — the order is the cleanup contract.
    expect(removeRoomStorageObjects.mock.invocationCallOrder[0]).toBeLessThan(
      deleteRoom.mock.invocationCallOrder[0],
    );
    expect(removeRoomStorageObjects).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
    );
    expect(deleteRoom).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
  });

  it("stops before the row delete when the storage sweep fails, leaving the room intact", async () => {
    removeRoomStorageObjects.mockRejectedValue(
      new ResourceError(
        "cleanup_failed",
        "The room's files could not be removed. Please try again.",
        500,
      ),
    );
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("cleanup_failed");
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it("maps a lost race on the row delete to 404 (the room is already gone)", async () => {
    deleteRoom.mockRejectedValue(
      new RoomMutationError(
        "not_found",
        "That room does not exist or is not available.",
        404,
      ),
    );
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 500 delete_failed without leaking the failure detail", async () => {
    deleteRoom.mockRejectedValue(
      new Error('update or delete on table "rooms" violates constraint'),
    );
    const { request, context } = del();

    const response = await DELETE(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("delete_failed");
    expect(JSON.stringify(body)).not.toContain("rooms");
  });
});
