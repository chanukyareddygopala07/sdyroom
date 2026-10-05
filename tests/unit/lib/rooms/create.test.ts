import { createRoom, mapRpcError, RoomError } from "@/lib/rooms/create";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it, vi } from "vitest";

const input = {
  name: "Calculus Study Room",
  capacity: 6,
  visibility: "public" as const,
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  shared_goal: "Finish the syllabus",
  status: "open" as const,
};

const rpcRow = {
  id: "room-1",
  name: "Calculus Study Room",
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  capacity: 6,
  status: "open",
  shared_goal: "Finish the syllabus",
  created_at: "2026-10-06T00:00:00.000Z",
  owner_id: "user-999",
  visibility: "public",
};

describe("createRoom", () => {
  it("calls the create_room RPC with the documented p_* arguments", async () => {
    const { client } = createFakeClient({ data: rpcRow });

    await createRoom(client as never, input);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("create_room", {
      p_name: "Calculus Study Room",
      p_capacity: 6,
      p_visibility: "public",
      p_exam_track: "JEE",
      p_subject: "Mathematics",
      p_language: "English",
      p_status: "open",
      p_shared_goal: "Finish the syllabus",
    });
  });

  it("returns the public shape without owner or visibility fields", async () => {
    const { client } = createFakeClient({ data: rpcRow });

    const room = await createRoom(client as never, input);

    expect(room).toEqual({
      id: "room-1",
      name: "Calculus Study Room",
      exam_track: "JEE",
      subject: "Mathematics",
      language: "English",
      capacity: 6,
      status: "open",
      shared_goal: "Finish the syllabus",
      created_at: "2026-10-06T00:00:00.000Z",
    });
    expect(room).not.toHaveProperty("owner_id");
    expect(room).not.toHaveProperty("visibility");
  });

  it("maps RPC errors onto stable codes and statuses", async () => {
    const cases: [{ code: string | null; message: string | null }, string, number][] = [
      [{ code: "22023", message: "capacity must be between 1 and 100" }, "validation", 400],
      [{ code: "42501", message: "permission denied" }, "permission_denied", 403],
      [{ code: "23514", message: "owner membership missing" }, "invariant_violation", 500],
      [{ code: "XX000", message: "unexpected failure" }, "rpc_failed", 500],
      [{ code: null, message: "TypeError: fetch failed" }, "network", 503],
    ];

    for (const [error, code, status] of cases) {
      const { client } = createFakeClient({ data: null, error });
      await expect(createRoom(client as never, input)).rejects.toMatchObject({
        name: "RoomError",
        code,
        status,
      });
    }
  });

  it("surfaces the database validation message to the client", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "22023", message: "name must not be empty" },
    });

    await expect(createRoom(client as never, input)).rejects.toThrow(
      "name must not be empty",
    );
  });

  it("treats a thrown fetch failure as an unavailable database", async () => {
    const client = {
      from: vi.fn(),
      rpc: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    };

    await expect(createRoom(client as never, input)).rejects.toMatchObject({
      code: "network",
      status: 503,
    });
  });

  it("fails closed when the RPC returns no row", async () => {
    const { client } = createFakeClient({ data: null, error: null });

    await expect(createRoom(client as never, input)).rejects.toMatchObject({
      code: "rpc_failed",
      status: 500,
    });
  });
});

describe("mapRpcError", () => {
  it("returns a RoomError for every branch", () => {
    expect(mapRpcError({ code: "42501", message: "x" })).toBeInstanceOf(
      RoomError,
    );
    expect(
      mapRpcError({ code: "XX000", message: "ECONNREFUSED" }).code,
    ).toBe("network");
    expect(mapRpcError({ code: null, message: null }).code).toBe("rpc_failed");
  });
});
