import {
  listPublicRooms,
  RoomQueryError,
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
