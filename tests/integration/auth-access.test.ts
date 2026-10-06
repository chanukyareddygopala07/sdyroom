import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as profilePost } from "@/app/api/profile/route";
import { GET as roomsGet, POST as roomsPost } from "@/app/api/rooms/route";
import { callApi, errorOf, readJson } from "./helpers/api";
import { clearCookies, cookieStore, seedSession } from "./helpers/cookie-jar";
import { createUser, deleteUsers, type TestUser } from "./helpers/users";

const validRoom = {
  name: "Access Check Room",
  capacity: 3,
  visibility: "public" as const,
  subject: "Physics",
};

describe("session access at the API boundary", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser("access");
    await seedSession(user.email, user.password);
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([user]);
  });

  it("rejects GET /api/rooms without a session", async () => {
    clearCookies();
    const response = await callApi(roomsGet, { path: "/api/rooms" });
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe("unauthenticated");
  });

  it("rejects POST /api/rooms without a session even with a valid body", async () => {
    clearCookies();
    const response = await callApi(roomsPost, {
      path: "/api/rooms",
      method: "POST",
      body: validRoom,
    });
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe("unauthenticated");
  });

  it("rejects POST /api/profile without a session", async () => {
    clearCookies();
    const response = await callApi(profilePost, {
      path: "/api/profile",
      method: "POST",
      body: { alias: "NoSession" },
    });
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe("unauthenticated");
  });

  it("rejects a forged session cookie instead of treating it as a user", async () => {
    clearCookies();
    cookieStore().set("sb-local-auth-token", "forged-session-value");
    const response = await callApi(roomsGet, { path: "/api/rooms" });
    expect(response.status).toBe(401);
    clearCookies();
  });

  it("accepts a real session for GET /api/rooms", async () => {
    await seedSession(user.email, user.password);
    const response = await callApi(roomsGet, { path: "/api/rooms" });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(Array.isArray(body.rooms)).toBe(true);
  });

  it("accepts a real session for POST /api/profile and returns own profile", async () => {
    await seedSession(user.email, user.password);
    const response = await callApi(profilePost, {
      path: "/api/profile",
      method: "POST",
      body: { alias: "AccessAlias" },
    });
    expect([200, 201]).toContain(response.status);
    const body = await readJson(response);
    const profile = body.profile as Record<string, unknown>;
    expect(profile.id).toBe(user.id);
    expect(profile.alias).toBe("AccessAlias");
  });

  it("keeps the session bound to the same user after a second sign-in", async () => {
    const other = await createUser("access-other");
    try {
      await seedSession(other.email, other.password);
      const response = await callApi(profilePost, {
        path: "/api/profile",
        method: "POST",
        body: { alias: "OtherAlias" },
      });
      expect(response.status).toBe(201);
      const body = await readJson(response);
      expect((body.profile as Record<string, unknown>).id).toBe(other.id);
      expect((body.profile as Record<string, unknown>).id).not.toBe(user.id);
    } finally {
      clearCookies();
      await deleteUsers([other]);
    }
  });
});
