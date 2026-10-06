import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

describe("requireRoomMembership", () => {
  it("resolves when the caller's own membership row exists", async () => {
    const { client, state } = createFakeClient({ data: [{ room_id: ROOM }] });

    await expect(requireRoomMembership(client as never, ROOM)).resolves.toBeUndefined();
    expect(state.select).toEqual(["room_id"]);
    expect(state.eq).toEqual([["room_id", ROOM]]);
    expect(state.limit).toEqual([1]);
  });

  it("reports an unknown room and a room you are not in as the same 404", async () => {
    const { client } = createFakeClient({ data: [] });

    const error = await requireRoomMembership(client as never, ROOM).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RoomAccessError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
    expect((error as Error).message).toBe(
      "That room does not exist or is not available.",
    );
    expect((error as Error).message).not.toMatch(/sql|policy|relation/i);
  });

  it("throws a plain error when the check itself fails", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "connection lost" },
    });

    const error = await requireRoomMembership(client as never, ROOM).catch(
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(RoomAccessError);
    expect((error as Error).message).toContain("membership check failed");
  });
});
