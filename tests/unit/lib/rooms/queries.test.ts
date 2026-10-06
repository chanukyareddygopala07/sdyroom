import {
  listPublicRooms,
  listViewerMemberships,
  RoomQueryError,
  roomMemberCounts,
  toIlikePattern,
} from "@/lib/rooms/queries";
import { PUBLIC_ROOM_COLUMNS } from "@/lib/rooms/types";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const row = {
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

describe("toIlikePattern", () => {
  it("wraps the term in wildcards", () => {
    expect(toIlikePattern("calculus")).toBe("%calculus%");
  });

  it("strips wildcard and filter-structure characters", () => {
    const pattern = toIlikePattern('100%_or"(name,eq)');
    const inner = pattern.slice(1, -1);

    expect(pattern).toBe("%100 or name eq%");
    expect(inner).not.toContain("%");
    expect(inner).not.toContain("_");
    expect(inner).not.toContain('"');
    expect(inner).not.toContain("(");
    expect(inner).not.toContain(")");
  });
});

describe("listPublicRooms", () => {
  it("requests only public rooms with an explicit column list", async () => {
    const { client, state } = createFakeClient({ data: [row] });

    const rooms = await listPublicRooms(client as never, { q: "" });

    expect(state.select).toEqual([PUBLIC_ROOM_COLUMNS]);
    expect(state.select[0]).not.toContain("*");
    expect(state.eq).toEqual([["visibility", "public"]]);
    expect(state.order).toEqual([
      ["created_at", { ascending: false }],
    ]);
    expect(state.limit).toEqual([50]);
    expect(state.or).toEqual([]);
    expect(rooms).toHaveLength(1);
    expect(client.from).toHaveBeenCalledWith("rooms");
  });

  it("shapes rows so owner and visibility fields never reach the response", async () => {
    const { client } = createFakeClient({
      data: [
        {
          ...row,
          owner_id: "user-999",
          visibility: "private",
          email: "owner@example.com",
        },
      ],
    });

    const [room] = await listPublicRooms(client as never, { q: "" });

    expect(room).toEqual(row);
    expect(room).not.toHaveProperty("owner_id");
    expect(room).not.toHaveProperty("visibility");
    expect(room).not.toHaveProperty("email");
  });

  it("adds an escaped ilike filter when a query is supplied", async () => {
    const { client, state } = createFakeClient({ data: [] });

    await listPublicRooms(client as never, { q: 'calc"us' });

    expect(state.or).toHaveLength(1);
    expect(state.or[0]).toBe(
      'name.ilike."%calc us%",subject.ilike."%calc us%",exam_track.ilike."%calc us%"',
    );
  });

  it("throws a RoomQueryError when the query fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(listPublicRooms(client as never, { q: "" })).rejects.toThrow(
      RoomQueryError,
    );
  });
});

describe("listViewerMemberships", () => {
  it("reads only room_id and role for the requested rooms", async () => {
    const { client, state } = createFakeClient({
      data: [
        { room_id: "room-1", role: "owner" },
        { room_id: "room-2", role: "student" },
      ],
    });

    const memberships = await listViewerMemberships(client as never, [
      "room-1",
      "room-2",
    ]);

    expect(client.from).toHaveBeenCalledWith("room_members");
    expect(state.select).toEqual(["room_id, role"]);
    expect(state.in).toEqual([["room_id", ["room-1", "room-2"]]]);
    expect(memberships).toEqual(
      new Map([
        ["room-1", "owner"],
        ["room-2", "student"],
      ]),
    );
  });

  it("does not query at all when there is nothing to look up", async () => {
    const { client } = createFakeClient({ data: [] });

    const memberships = await listViewerMemberships(client as never, []);

    expect(client.from).not.toHaveBeenCalled();
    expect(memberships.size).toBe(0);
  });

  it("throws a RoomQueryError when the query fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(
      listViewerMemberships(client as never, ["room-1"]),
    ).rejects.toThrow(RoomQueryError);
  });
});

describe("roomMemberCounts", () => {
  it("asks the RPC for aggregate counts and builds a lookup", async () => {
    const { client, rpcCalls } = createFakeClient({
      data: [
        { room_id: "room-1", member_count: 3 },
        { room_id: "room-2", member_count: 0 },
      ],
    });

    const counts = await roomMemberCounts(client as never);

    expect(rpcCalls).toEqual([
      { fn: "public_room_member_counts", args: undefined },
    ]);
    expect(counts).toEqual(
      new Map([
        ["room-1", 3],
        ["room-2", 0],
      ]),
    );
  });

  it("falls back to 0 for a malformed count", async () => {
    const { client } = createFakeClient({
      data: [{ room_id: "room-1", member_count: "many" }],
    });

    expect((await roomMemberCounts(client as never)).get("room-1")).toBe(0);
  });

  it("throws a RoomQueryError when the RPC fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(roomMemberCounts(client as never)).rejects.toThrow(
      RoomQueryError,
    );
  });
});
