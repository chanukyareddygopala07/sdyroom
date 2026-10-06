import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countRoomsOwnedBy, psqlExpectingFailure, roomMembersInsertGranted } from "./helpers/admin";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import {
  createUser,
  deleteUsers,
  uniqueName,
  type TestUser,
} from "./helpers/users";

describe("atomic room creation", () => {
  let owner: TestUser;

  beforeAll(async () => {
    owner = await createUser("atomic");
  });

  afterAll(async () => {
    await deleteUsers([owner]);
  });

  it("commits the room and its owner membership together", async () => {
    const name = uniqueName("Atomic");
    const room = await createRoom(
      owner.client,
      createRoomSchema.parse({ name, capacity: 4 }),
    );
    expect(room.id).toBeTruthy();
    expect(room.name).toBe(name);

    const { data: memberships, error } = await owner.client
      .from("room_members")
      .select("room_id, user_id, role")
      .eq("room_id", room.id);
    expect(error).toBeNull();
    expect(memberships).toHaveLength(1);
    expect(memberships?.[0]).toMatchObject({ user_id: owner.id, role: "owner" });

    expect(countRoomsOwnedBy(owner.id)).toBe(1);
  });

  it("never commits a room whose owner membership insert fails", async () => {
    const before = countRoomsOwnedBy(owner.id);

    const { error } = await owner.client
      .from("rooms")
      .insert({ owner_id: owner.id, name: uniqueName("NoMembership") });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");

    expect(countRoomsOwnedBy(owner.id)).toBe(before);

    const { data: visible } = await owner.client
      .from("rooms")
      .select("id, name")
      .like("name", "%NoMembership%");
    expect(visible).toHaveLength(0);
  });

  it("rolls the room insert back when the membership grant is revoked, and leaves the grant as it was", async () => {
    const before = countRoomsOwnedBy(owner.id);

    // One psql session, one transaction: the REVOKE and the create_room call
    // are attempted together, the call fails, and everything — including the
    // REVOKE — rolls back. This is admin SQL for setup/teardown only; the room
    // rows themselves are still written exclusively by the production RPC.
    const { status, output } = psqlExpectingFailure(
      [
        "begin;",
        "revoke insert on public.room_members from authenticated;",
        "set local role authenticated;",
        `set local request.jwt.claim.sub = '${owner.id}';`,
        `set local request.jwt.claims = '{"sub":"${owner.id}"}';`,
        "select public.create_room('Rollback Probe', 4, 'public');",
        "commit;",
      ].join("\n"),
    );

    expect(status).not.toBe(0);
    expect(output).toContain("permission denied for table room_members");

    expect(roomMembersInsertGranted()).toBe(true);
    expect(countRoomsOwnedBy(owner.id)).toBe(before);

    const { data: visible } = await owner.client
      .from("rooms")
      .select("id, name")
      .eq("name", "Rollback Probe");
    expect(visible).toHaveLength(0);
  });

  it("still creates rooms normally after the failed transaction", async () => {
    const room = await createRoom(
      owner.client,
      createRoomSchema.parse({ name: uniqueName("AfterRollback"), capacity: 2 }),
    );
    const { data: memberships } = await owner.client
      .from("room_members")
      .select("room_id")
      .eq("room_id", room.id);
    expect(memberships).toHaveLength(1);
  });

  describe("defense in depth inside the RPC", () => {
    it("rejects an out-of-range capacity with 22023", async () => {
      const { data, error } = await owner.client.rpc("create_room", {
        p_name: "Bad Capacity",
        p_capacity: 0,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("22023");
    });

    it("rejects an over-long name with 22023", async () => {
      const { data, error } = await owner.client.rpc("create_room", {
        p_name: "x".repeat(101),
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("22023");
    });

    it("rejects an unknown visibility value with 22023", async () => {
      const { data, error } = await owner.client.rpc("create_room", {
        p_name: "Bad Visibility",
        p_visibility: "hidden",
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("22023");
    });

    it("accepts no owner argument at all, so ownership cannot be spoofed", async () => {
      const { data, error } = await owner.client.rpc("create_room", {
        p_name: "Spoof Attempt",
        p_owner_id: "11111111-1111-1111-1111-111111111111",
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("PGRST202");
      expect(countRoomsOwnedBy(owner.id)).toBe(2);
    });
  });
});
