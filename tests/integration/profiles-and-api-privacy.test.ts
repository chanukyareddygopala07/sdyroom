import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as profilePost } from "@/app/api/profile/route";
import { GET as roomsGet, POST as roomsPost } from "@/app/api/rooms/route";
import { callApi, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const ROOM_KEYS = [
  "capacity",
  "created_at",
  "exam_track",
  "id",
  "language",
  "name",
  "shared_goal",
  "status",
  "subject",
].sort();

describe("onboarding and API response privacy", () => {
  let alice: TestUser;
  let bob: TestUser;
  let newbie: TestUser;
  const takenAlias = uniqueAlias("Taken");

  beforeAll(async () => {
    [alice, bob, newbie] = await Promise.all([
      createUser("alice"),
      createUser("bob"),
      createUser("newbie"),
    ]);
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([alice, bob, newbie]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  it("creates a profile and returns only id and alias", async () => {
    await as(alice);
    const response = await callApi(profilePost, {
      path: "/api/profile",
      method: "POST",
      body: { alias: takenAlias },
    });
    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body.created).toBe(true);
    const profile = body.profile as Record<string, unknown>;
    expect(Object.keys(profile).sort()).toEqual(["alias", "id"]);
    expect(profile.id).toBe(alice.id);
    expect(profile.alias).toBe(takenAlias);
    expect(JSON.stringify(body)).not.toContain(alice.email);
    expect(JSON.stringify(body)).not.toContain("@");
  });

  it("is idempotent when the same user posts onboarding twice", async () => {
    await as(alice);
    const response = await callApi(profilePost, {
      path: "/api/profile",
      method: "POST",
      body: { alias: "SomeOtherAlias" },
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.created).toBe(false);
    expect((body.profile as Record<string, unknown>).alias).toBe(takenAlias);
  });

  it("rejects a case-insensitively duplicated alias with 409", async () => {
    await as(bob);
    const response = await callApi(profilePost, {
      path: "/api/profile",
      method: "POST",
      body: { alias: takenAlias.toUpperCase() },
    });
    expect(response.status).toBe(409);
    expect(errorOf(await readJson(response)).code).toBe("alias_taken");
  });

  it("validates alias length, trimming and emptiness", async () => {
    await as(newbie);
    for (const alias of ["x".repeat(33), "   ", ""]) {
      const response = await callApi(profilePost, {
        path: "/api/profile",
        method: "POST",
        body: { alias },
      });
      expect(response.status).toBe(400);
      const error = errorOf(await readJson(response));
      expect(error.code).toBe("validation");
      expect(error.issues?.length).toBeGreaterThan(0);
    }
  });

  it("refuses room creation before onboarding", async () => {
    await as(newbie);
    const response = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      body: { name: "Too Early", capacity: 2 },
    });
    expect(response.status).toBe(403);
    expect(errorOf(await readJson(response)).code).toBe("onboarding_required");
  });

  it("rejects a malformed JSON body", async () => {
    await as(alice);
    const response = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      rawBody: '{"name": "unterminated',
    });
    expect(response.status).toBe(400);
    expect(errorOf(await readJson(response)).code).toBe("invalid_json");
  });

  it("rejects invalid room fields with validation issues", async () => {
    await as(alice);
    const cases = [
      { name: "", capacity: 2 },
      { name: "   ", capacity: 2 },
      { name: "x".repeat(101), capacity: 2 },
      { name: "Capacity", capacity: 0 },
      { name: "Capacity", capacity: 101 },
      { name: "Visibility", visibility: "hidden" },
      { name: "Status", status: "paused" },
      { name: "Shared", shared_goal: "x".repeat(501) },
    ];
    for (const body of cases) {
      const response = await callApi(roomsPost, {
        path: "/api/rooms",
        method: "POST",
        body,
      });
      expect(response.status, `body: ${JSON.stringify(body)}`).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe("validation");
    }
  });

  it("creates a room and returns exactly the public room shape", async () => {
    await as(alice);
    const response = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      body: { name: uniqueName("Alice"), capacity: 4, subject: "Chemistry" },
    });
    expect(response.status).toBe(201);
    const body = await readJson(response);
    const room = body.room as Record<string, unknown>;
    expect(Object.keys(room).sort()).toEqual(ROOM_KEYS);
    expect(room.subject).toBe("Chemistry");
    expect(JSON.stringify(body)).not.toContain("owner_id");
    expect(JSON.stringify(body)).not.toContain(alice.id);
  });

  it("lists public rooms without leaking private ones or owner ids", async () => {
    const privateName = uniqueName("Private");
    await as(alice);
    const created = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      body: { name: privateName, visibility: "private", capacity: 2 },
    });
    expect(created.status).toBe(201);

    const publicName = uniqueName("Public");
    const publicCreated = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      body: { name: publicName, visibility: "public", capacity: 2 },
    });
    expect(publicCreated.status).toBe(201);

    // Owner's own discovery view: public room present, private room filtered out.
    const own = await readJson(await callApi(roomsGet, { path: "/api/rooms" }));
    const ownRooms = own.rooms as Record<string, unknown>[];
    expect(ownRooms.some((room) => room.name === publicName)).toBe(true);
    expect(ownRooms.some((room) => room.name === privateName)).toBe(false);

    // Another signed-in student must not see the private room either.
    await as(bob);
    const others = await readJson(await callApi(roomsGet, { path: "/api/rooms" }));
    const otherRooms = others.rooms as Record<string, unknown>[];
    expect(otherRooms.some((room) => room.name === privateName)).toBe(false);
    expect(otherRooms.some((room) => room.name === publicName)).toBe(true);

    for (const room of [...ownRooms, ...otherRooms]) {
      expect(Object.keys(room).sort()).toEqual(ROOM_KEYS);
      expect(JSON.stringify(room)).not.toContain("owner_id");
    }
  });

  it("searches public rooms by name without matching other rows", async () => {
    const needle = uniqueName("Needle");
    await as(alice);
    const created = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      body: { name: needle, capacity: 2 },
    });
    expect(created.status).toBe(201);

    const hit = await readJson(
      await callApi(roomsGet, { path: `/api/rooms?q=${encodeURIComponent(needle)}` }),
    );
    const hitRooms = hit.rooms as Record<string, unknown>[];
    expect(hitRooms.map((room) => room.name)).toEqual([needle]);

    const miss = await readJson(
      await callApi(roomsGet, { path: "/api/rooms?q=zzz-no-such-room-zzz" }),
    );
    expect(miss.rooms).toEqual([]);
  });

  it("does not expose the service account or other users in any response", async () => {
    await as(bob);
    const responses = [
      await callApi(roomsGet, { path: "/api/rooms" }),
      await callApi(profilePost, {
        path: "/api/profile",
        method: "POST",
        body: { alias: uniqueAlias("Bob") },
      }),
    ];
    for (const response of responses) {
      const text = JSON.stringify(await readJson(response));
      expect(text).not.toContain("service_role");
      expect(text).not.toContain("sb_secret_");
      expect(text).not.toContain(alice.email);
      expect(text).not.toContain(alice.id);
    }
  });
});
