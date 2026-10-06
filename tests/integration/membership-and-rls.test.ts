import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { integrationEnv } from "./helpers/env";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

function anonClient(): SupabaseClient {
  const { apiUrl, publishableKey } = integrationEnv();
  return createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

describe("row level security and grants", () => {
  let anon: SupabaseClient;
  let alice: TestUser;
  let bob: TestUser;
  let aliceAlias: string;
  let bobAlias: string;
  let alicePrivateRoomId: string;
  let alicePrivateRoomName: string;

  beforeAll(async () => {
    anon = anonClient();
    [alice, bob] = await Promise.all([createUser("rls-alice"), createUser("rls-bob")]);

    aliceAlias = uniqueAlias("Rlsa");
    bobAlias = uniqueAlias("Rlsb");
    await createProfile(alice.client, alice.id, aliceAlias);
    await createProfile(bob.client, bob.id, bobAlias);

    alicePrivateRoomName = uniqueName("Hidden");
    const room = await createRoom(
      alice.client,
      createRoomSchema.parse({
        name: alicePrivateRoomName,
        visibility: "private",
        capacity: 2,
      }),
    );
    alicePrivateRoomId = room.id;
  });

  afterAll(async () => {
    await deleteUsers([alice, bob]);
  });

  describe("anon", () => {
    it("is denied reading rooms instead of receiving an empty list", async () => {
      const { data, error } = await anon.from("rooms").select("id");
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });

    it("is denied reading profiles", async () => {
      const { data, error } = await anon.from("profiles").select("id");
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });

    it("is denied calling create_room", async () => {
      const { data, error } = await anon.rpc("create_room", { p_name: "Anon Room" });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });

    it("is denied updating and deleting rooms", async () => {
      const updated = await anon
        .from("rooms")
        .update({ name: "Anon Edit" })
        .eq("id", alicePrivateRoomId)
        .select("id");
      expect(updated.error?.code).toBe("42501");
      expect(updated.data).toBeNull();

      const deleted = await anon
        .from("rooms")
        .delete()
        .eq("id", alicePrivateRoomId)
        .select("id");
      expect(deleted.error?.code).toBe("42501");
      expect(deleted.data).toBeNull();
    });
  });

  describe("authenticated role", () => {
    it("is denied updating a room it owns (no UPDATE grant, not zero rows)", async () => {
      const { data, error } = await alice.client
        .from("rooms")
        .update({ name: "Should Not Apply" })
        .eq("id", alicePrivateRoomId)
        .select("id");
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });

    it("is denied deleting a room it owns (no DELETE grant)", async () => {
      const { data, error } = await alice.client
        .from("rooms")
        .delete()
        .eq("id", alicePrivateRoomId)
        .select("id");
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });

    it("is denied inserting a room that claims another user as owner", async () => {
      const { error } = await bob.client
        .from("rooms")
        .insert({ owner_id: alice.id, name: uniqueName("Spoofed") });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });

    it("is denied inserting a profile row for another user", async () => {
      const { error } = await bob.client
        .from("profiles")
        .insert({ id: alice.id, alias: uniqueAlias("Spoof") });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });
  });

  describe("visibility", () => {
    it("shows a private room only to its owner", async () => {
      const { data: aliceRows, error: aliceError } = await alice.client
        .from("rooms")
        .select("id, name")
        .eq("id", alicePrivateRoomId);
      expect(aliceError).toBeNull();
      expect(aliceRows).toHaveLength(1);

      const { data: bobRows, error: bobError } = await bob.client
        .from("rooms")
        .select("id, name")
        .eq("id", alicePrivateRoomId);
      expect(bobError).toBeNull();
      expect(bobRows).toHaveLength(0);
    });

    it("shows membership rows only to the member", async () => {
      const { data: aliceRows } = await alice.client
        .from("room_members")
        .select("room_id, role")
        .eq("room_id", alicePrivateRoomId);
      expect(aliceRows).toHaveLength(1);
      expect(aliceRows?.[0].role).toBe("owner");

      const { data: bobRows, error: bobError } = await bob.client
        .from("room_members")
        .select("room_id, role")
        .eq("room_id", alicePrivateRoomId);
      // Grant exists, RLS filters: an empty list is correct here, unlike the
      // 42501 privilege errors asserted above.
      expect(bobError).toBeNull();
      expect(bobRows).toHaveLength(0);
    });

    it("shows only the caller's own profile row", async () => {
      const { data: bobRows, error } = await bob.client
        .from("profiles")
        .select("id, alias");
      expect(error).toBeNull();
      expect(bobRows).toHaveLength(1);
      expect(bobRows?.[0].id).toBe(bob.id);
    });
  });

  describe("membership writes", () => {
    it("rejects a non-owner adding themselves to someone else's room", async () => {
      const { error } = await bob.client.from("room_members").insert({
        room_id: alicePrivateRoomId,
        user_id: bob.id,
        role: "owner",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });

    it("rejects a non-owner writing a membership row for someone else", async () => {
      const { error } = await bob.client.from("room_members").insert({
        room_id: alicePrivateRoomId,
        user_id: alice.id,
        role: "student",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });

    it("rejects a membership row for a room the caller does not own, before the foreign key runs", async () => {
      const { error } = await alice.client.from("room_members").insert({
        room_id: "00000000-0000-4000-8000-000000000000",
        user_id: alice.id,
        role: "owner",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });
  });

  describe("profile updates", () => {
    it("updates the caller's own alias", async () => {
      const next = uniqueAlias("Rlsa2");
      const { data, error } = await alice.client
        .from("profiles")
        .update({ alias: next })
        .eq("id", alice.id)
        .select("id, alias");
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0].alias).toBe(next);
      aliceAlias = next;
    });

    it("touches zero rows for another user's profile instead of erroring", async () => {
      const attempted = uniqueAlias("RlsX");
      const { data, error } = await bob.client
        .from("profiles")
        .update({ alias: attempted })
        .eq("id", alice.id)
        .select("id, alias");
      expect(error).toBeNull();
      expect(data).toHaveLength(0);

      const { data: unchanged } = await alice.client
        .from("profiles")
        .select("alias")
        .eq("id", alice.id)
        .maybeSingle();
      expect(unchanged?.alias).toBe(aliceAlias);
    });
  });
});
