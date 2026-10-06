import {
  joinRoom,
  leaveRoom,
  MembershipError,
} from "@/lib/rooms/membership";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

describe("joinRoom", () => {
  it("calls join_room with only the room id", async () => {
    const { client, rpcCalls } = createFakeClient({
      data: { code: "joined", member_count: 3 },
    });

    const result = await joinRoom(client as never, ROOM);

    expect(rpcCalls).toEqual([
      { fn: "join_room", args: { p_room_id: ROOM } },
    ]);
    expect(result).toEqual({ membership: "joined", member_count: 3 });
  });

  it("reports an idempotent repeat as already_member", async () => {
    const { client } = createFakeClient({
      data: { code: "already_member", member_count: 4 },
    });

    expect(await joinRoom(client as never, ROOM)).toEqual({
      membership: "already_member",
      member_count: 4,
    });
  });

  it("returns a null member_count when the room has no aggregate count", async () => {
    const { client } = createFakeClient({
      data: { code: "already_member", member_count: null },
    });

    expect(await joinRoom(client as never, ROOM)).toEqual({
      membership: "already_member",
      member_count: null,
    });
  });

  it.each([
    ["room_not_found", "not_found", 404],
    ["room_closed", "room_closed", 409],
    ["room_full", "room_full", 409],
  ])("maps %s onto a %s %d", async (code, expected, status) => {
    const { client } = createFakeClient({
      data: { code, member_count: null },
    });

    const error = await joinRoom(client as never, ROOM).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MembershipError);
    expect(error).toMatchObject({ code: expected, status });
  });

  it("keeps SQL details out of the message a client would see", async () => {
    const { client } = createFakeClient({
      data: { code: "room_full", member_count: null },
    });

    const error = (await joinRoom(client as never, ROOM).catch(
      (e: unknown) => e,
    )) as MembershipError;

    expect(error.message).toBe("This room is full.");
    expect(error.message).not.toMatch(/sql|relation|constraint|select/i);
  });

  it("throws a plain error for an unexpected envelope", async () => {
    const { client } = createFakeClient({ data: { code: "surprise" } });

    await expect(joinRoom(client as never, ROOM)).rejects.toThrow(
      /Unexpected membership result/,
    );
  });

  it("throws a plain error when the RPC call itself fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "fetch failed" },
    });

    const error = await joinRoom(client as never, ROOM).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(MembershipError);
    expect((error as Error).message).toContain("join_room failed");
  });
});

describe("leaveRoom", () => {
  it("calls leave_room with only the room id", async () => {
    const { client, rpcCalls } = createFakeClient({
      data: { code: "left", member_count: 2 },
    });

    expect(await leaveRoom(client as never, ROOM)).toEqual({
      membership: "left",
      member_count: 2,
    });
    expect(rpcCalls).toEqual([
      { fn: "leave_room", args: { p_room_id: ROOM } },
    ]);
  });

  it.each([
    ["room_not_found", "not_found", 404],
    ["owner_cannot_leave", "owner_cannot_leave", 409],
    ["not_a_member", "not_a_member", 409],
  ])("maps %s onto a %s %d", async (code, expected, status) => {
    const { client } = createFakeClient({
      data: { code, member_count: null },
    });

    const error = await leaveRoom(client as never, ROOM).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MembershipError);
    expect(error).toMatchObject({ code: expected, status });
  });
});
