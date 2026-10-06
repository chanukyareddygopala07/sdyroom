import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { POST as leavePost } from "@/app/api/rooms/[id]/leave/route";
import { POST as joinPost } from "@/app/api/rooms/[id]/join/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom, MembershipError } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { integrationEnv } from "./helpers/env";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const UUID = "00000000-0000-4000-8000-000000000000";

function anonClient(): SupabaseClient {
  const { apiUrl, publishableKey } = integrationEnv();
  return createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

describe("joining and leaving public rooms", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let dan: TestUser;
  let erin: TestUser;
  let frank: TestUser;
  let grace: TestUser;

  let openRoom: string;
  let tinyRoom: string;
  let closedRoom: string;
  let privateRoom: string;
  let raceRoom: string;

  beforeAll(async () => {
    [alice, bob, carol, dan, erin, frank, grace] = await Promise.all([
      createUser("join-alice"),
      createUser("join-bob"),
      createUser("join-carol"),
      createUser("join-dan"),
      createUser("join-erin"),
      createUser("join-frank"),
      createUser("join-grace"),
    ]);

    await Promise.all(
      [alice, bob, carol, dan, erin, frank, grace].map((user, index) =>
        createProfile(
          user.client,
          user.id,
          uniqueAlias(`J${index}`),
        ),
      ),
    );

    openRoom = (await createRoom(alice.client, createRoomSchema.parse({ name: uniqueName("Open"), capacity: 4 }))).id;
    tinyRoom = (await createRoom(alice.client, createRoomSchema.parse({ name: uniqueName("Tiny"), capacity: 1 }))).id;
    closedRoom = (await createRoom(alice.client, createRoomSchema.parse({ name: uniqueName("Closed"), capacity: 4, status: "closed" }))).id;
    privateRoom = (await createRoom(alice.client, createRoomSchema.parse({ name: uniqueName("Hidden"), capacity: 4, visibility: "private" }))).id;
    raceRoom = (await createRoom(alice.client, createRoomSchema.parse({ name: uniqueName("Race"), capacity: 4 }))).id;
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([alice, bob, carol, dan, erin, frank, grace]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function join(user: TestUser, roomId: string, body?: unknown) {
    return callApiWithParams(
      joinPost,
      { path: `/api/rooms/${roomId}/join`, method: "POST", body },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function leave(user: TestUser, roomId: string, body?: unknown) {
    return callApiWithParams(
      leavePost,
      { path: `/api/rooms/${roomId}/leave`, method: "POST", body },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  async function countOf(roomId: string): Promise<number | null> {
    const { data, error } = await alice.client.rpc("public_room_member_counts");
    expect(error).toBeNull();
    const row = (data as { room_id: string; member_count: number }[]).find(
      (entry) => entry.room_id === roomId,
    );
    return row ? row.member_count : null;
  }

  describe("request guards", () => {
    it("rejects an anonymous join with 401 and writes nothing", async () => {
      clearCookies();
      const { response, body } = await join(bob, openRoom, {});

      expect(response.status).toBe(401);
      expect(errorOf(body).code).toBe("unauthenticated");
      expect(await countOf(openRoom)).toBe(1);
    });

    it("rejects an anonymous leave with 401", async () => {
      clearCookies();
      const { response } = await leave(bob, openRoom, {});

      expect(response.status).toBe(401);
    });

    it("rejects a room id that is not a UUID before touching the database", async () => {
      await as(bob);
      const { response, body } = await join(bob, "not-a-uuid", {});

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("validation");
    });

    it("refuses identity supplied in the body instead of using it", async () => {
      await as(grace);
      const { response, body } = await join(grace, openRoom, {
        user_id: alice.id,
        role: "owner",
      });

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("invalid_request");
      expect(errorOf(body).issues?.[0]?.path).toBe("user_id");
      expect(await countOf(openRoom)).toBe(1);

      const { data } = await grace.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", openRoom);
      expect(data).toHaveLength(0);
    });

    it("rejects a malformed JSON body", async () => {
      await as(bob);
      const response = await callApiWithParams(
        joinPost,
        { path: `/api/rooms/${openRoom}/join`, method: "POST", rawBody: "{not json" },
        { id: openRoom },
      );

      expect(response.status).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe("invalid_json");
    });
  });

  describe("joining", () => {
    it("joins an open public room and counts the seat", async () => {
      await as(bob);
      const { response, body } = await join(bob, openRoom, {});

      expect(response.status).toBe(201);
      expect(body).toEqual({ membership: "joined", member_count: 2 });
      expect(JSON.stringify(body)).not.toContain("@");
      expect(JSON.stringify(body)).not.toContain(alice.id);
      expect(JSON.stringify(body)).not.toContain("owner_id");
      expect(await countOf(openRoom)).toBe(2);
    });

    it("treats a repeat join as idempotent and never duplicates the row", async () => {
      await as(bob);
      const { response, body } = await join(bob, openRoom);

      expect(response.status).toBe(200);
      expect(body).toEqual({ membership: "already_member", member_count: 2 });
      expect(await countOf(openRoom)).toBe(2);

      const { data } = await bob.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", openRoom);
      expect(data).toHaveLength(1);
    });

    it("tells the owner they are already a member instead of adding a second row", async () => {
      await as(alice);
      const { response, body } = await join(alice, openRoom, {});

      expect(response.status).toBe(200);
      expect(body).toEqual({ membership: "already_member", member_count: 2 });
      expect(await countOf(openRoom)).toBe(2);
    });

    it("answers 404 for a private room, exactly as for a missing one", async () => {
      await as(bob);
      const priv = await join(bob, privateRoom, {});
      const missing = await join(bob, UUID, {});

      expect(priv.response.status).toBe(404);
      expect(missing.response.status).toBe(404);
      expect(errorOf(priv.body).code).toBe("not_found");
      expect(priv.body).toEqual(missing.body);
    });

    it("refuses a new member once the room is closed", async () => {
      await as(carol);
      const { response, body } = await join(carol, closedRoom, {});

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("room_closed");
    });

    it("keeps an existing member when their room is already closed", async () => {
      await as(alice);
      const { response, body } = await join(alice, closedRoom, {});

      expect(response.status).toBe(200);
      expect(body.membership).toBe("already_member");
    });

    it("refuses a join that would exceed capacity, which counts the owner", async () => {
      expect(await countOf(tinyRoom)).toBe(1);

      await as(dan);
      const { response, body } = await join(dan, tinyRoom, {});

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("room_full");
      expect(await countOf(tinyRoom)).toBe(1);
    });
  });

  describe("leaving", () => {
    it("frees the caller's seat and lets them rejoin later", async () => {
      await as(bob);
      const left = await leave(bob, openRoom, {});
      expect(left.response.status).toBe(200);
      expect(left.body).toEqual({ membership: "left", member_count: 1 });
      expect(await countOf(openRoom)).toBe(1);

      const rejoined = await join(bob, openRoom, {});
      expect(rejoined.response.status).toBe(201);
      expect(rejoined.body).toEqual({ membership: "joined", member_count: 2 });
      expect(await countOf(openRoom)).toBe(2);
    });

    it("refuses to remove the owner's membership", async () => {
      await as(alice);
      const { response, body } = await leave(alice, openRoom, {});

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("owner_cannot_leave");
      expect(await countOf(openRoom)).toBe(2);

      const { data } = await alice.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", openRoom);
      expect(data).toHaveLength(1);
    });

    it("refuses a leave from someone who never joined", async () => {
      await as(grace);
      const { response, body } = await leave(grace, openRoom, {});

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("not_a_member");
    });

    it("answers 404 when the room does not exist", async () => {
      await as(bob);
      const { response, body } = await leave(bob, UUID, {});

      expect(response.status).toBe(404);
      expect(errorOf(body).code).toBe("not_found");
    });

    it("refuses a leave that names someone else in the body", async () => {
      await as(grace);
      const { response, body } = await leave(grace, openRoom, {
        user_id: bob.id,
      });

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("invalid_request");
      expect(await countOf(openRoom)).toBe(2);
    });
  });

  describe("capacity under concurrency", () => {
    it("lets exactly the free seats be taken when students race", async () => {
      const racers = [bob, carol, dan, erin, frank];

      const results = await Promise.all(
        racers.map((user) =>
          joinRoom(user.client, raceRoom).then(
            (result) => ({ user, ok: true as const, result }),
            (error: unknown) => ({ user, ok: false as const, error }),
          ),
        ),
      );

      const joined = results.filter(
        (entry) => entry.ok && entry.result.membership === "joined",
      );
      const rejected = results.filter(
        (entry) =>
          !entry.ok &&
          entry.error instanceof MembershipError &&
          entry.error.code === "room_full",
      );

      expect(joined).toHaveLength(3);
      expect(rejected).toHaveLength(2);

      // Owner + exactly three students: capacity is never exceeded.
      expect(await countOf(raceRoom)).toBe(4);

      // A winner really holds one seat and a loser holds none.
      for (const entry of results) {
        const { data } = await entry.user.client
          .from("room_members")
          .select("room_id")
          .eq("room_id", raceRoom);
        expect(data, entry.user.email).toHaveLength(entry.ok ? 1 : 0);
      }
    });
  });

  describe("direct writes cannot bypass the functions", () => {
    it("denies a student inserting their own membership row", async () => {
      const { error } = await grace.client.from("room_members").insert({
        room_id: openRoom,
        user_id: grace.id,
        role: "student",
      });

      expect(error?.code).toBe("42501");
      expect(await countOf(openRoom)).toBe(2);
    });

    it("denies a student claiming the owner role for themselves", async () => {
      const { error } = await grace.client.from("room_members").insert({
        room_id: openRoom,
        user_id: grace.id,
        role: "owner",
      });

      expect(error?.code).toBe("42501");
    });

    it("denies a member deleting their own row through PostgREST", async () => {
      const { error } = await bob.client
        .from("room_members")
        .delete()
        .eq("room_id", openRoom)
        .eq("user_id", bob.id);

      expect(error?.code).toBe("42501");
      expect(await countOf(openRoom)).toBe(2);

      const { data } = await bob.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", openRoom);
      expect(data).toHaveLength(1);
    });

    it("denies anon calling either membership function", async () => {
      const anon = anonClient();

      const joined = await anon.rpc("join_room", { p_room_id: openRoom });
      expect(joined.error?.code).toBe("42501");
      expect(joined.data).toBeNull();

      const left = await anon.rpc("leave_room", { p_room_id: openRoom });
      expect(left.error?.code).toBe("42501");
      expect(left.data).toBeNull();
    });
  });

  describe("occupancy reporting", () => {
    it("reports aggregate seat usage for public rooms only", async () => {
      const { data, error } = await alice.client.rpc("public_room_member_counts");
      expect(error).toBeNull();

      const rows = data as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["member_count", "room_id"]);
      }

      const ids = rows.map((row) => row.room_id);
      expect(ids).toContain(openRoom);
      expect(ids).not.toContain(privateRoom);

      expect(await countOf(openRoom)).toBe(2);
      expect(await countOf(tinyRoom)).toBe(1);
      expect(await countOf(raceRoom)).toBe(4);
    });

    it("exposes only the caller's own membership rows", async () => {
      await as(bob);
      const { data, error } = await bob.client
        .from("room_members")
        .select("user_id, role")
        .eq("room_id", openRoom);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0].user_id).toBe(bob.id);
      expect(JSON.stringify(data)).not.toContain(alice.id);
    });

    it("lets anon read neither occupancy nor membership", async () => {
      const anon = anonClient();

      const counts = await anon.rpc("public_room_member_counts");
      expect(counts.error?.code).toBe("42501");

      const rows = await anon.from("room_members").select("user_id");
      expect(rows.error?.code).toBe("42501");
    });
  });
});
