import {
  DELETE as muteDelete,
  POST as mutePost,
} from "@/app/api/rooms/[id]/members/[alias]/mute/route";
import { POST as tokenPost } from "@/app/api/rooms/[id]/meeting/token/route";
import { MEETING_TOKEN_TTL_SECONDS } from "@/lib/meeting/config";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { callApiWithParams, errorOf, readJson, withoutRequestId } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const LIVEKIT_URL = "wss://example.livekit.cloud";
const LIVEKIT_API_KEY = "APIkeyEXAMPLE";
const LIVEKIT_API_SECRET = "secretEXAMPLEvalue1234567890";

function stubLiveKitEnv() {
  vi.stubEnv("LIVEKIT_URL", LIVEKIT_URL);
  vi.stubEnv("LIVEKIT_API_KEY", LIVEKIT_API_KEY);
  vi.stubEnv("LIVEKIT_API_SECRET", LIVEKIT_API_SECRET);
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("meeting tokens against the live stack", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let dave: TestUser;

  let bobAlias: string;

  let roomId: string;
  let daveRoomId: string;

  beforeAll(async () => {
    stubLiveKitEnv();
    [alice, bob, carol, dave] = await Promise.all([
      createUser("meet-alice"),
      createUser("meet-bob"),
      createUser("meet-carol"),
      createUser("meet-dave"),
    ]);
    const bobProfile = await createProfile(bob.client, bob.id, uniqueAlias("MB"));
    bobAlias = bobProfile.alias;
    await Promise.all([
      createProfile(alice.client, alice.id, uniqueAlias("MA")),
      createProfile(carol.client, carol.id, uniqueAlias("MC")),
      // Dave mints in a private loop below; he still needs the profile row
      // the token route reads for the display name.
      createProfile(dave.client, dave.id, uniqueAlias("MD")),
    ]);

    roomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("MeetingRoom"), capacity: 4 }),
      )
    ).id;
    await joinRoom(bob.client, roomId);

    daveRoomId = (
      await createRoom(
        dave.client,
        createRoomSchema.parse({ name: uniqueName("RateRoom"), capacity: 2 }),
      )
    ).id;
  });

  afterAll(async () => {
    clearCookies();
    vi.unstubAllEnvs();
    await deleteUsers([alice, bob, carol, dave]);
  });

  afterEach(() => {
    clearCookies();
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function mint(roomIdArg: string, body?: unknown) {
    return callApiWithParams(
      tokenPost,
      {
        path: `/api/rooms/${roomIdArg}/meeting/token`,
        method: "POST",
        body,
      },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  it("answers 401 for a caller with no session", async () => {
    const { response, body } = await mint(roomId, {});

    expect(response.status).toBe(401);
    expect(errorOf(body).code).toBe("unauthenticated");
  });

  it("mints a joinable token for a member, scoped to exactly this room", async () => {
    await as(bob);
    const { response, body } = await mint(roomId, {});

    expect(response.status).toBe(200);
    expect(body.url).toBe(LIVEKIT_URL);
    expect(body.room).toBe(`sdyroom-${roomId}`);
    expect(body.identity).toBe(bob.id);
    expect(body.expires_in).toBe(MEETING_TOKEN_TTL_SECONDS);
    expect(body.can_publish_mic).toBe(true);

    const claims = decodeClaims(String(body.token));
    expect(claims.iss).toBe(LIVEKIT_API_KEY);
    expect(claims.sub).toBe(bob.id);
    expect(claims.name).toBe(bobAlias);
    const video = claims.video as Record<string, unknown>;
    expect(video.room).toBe(`sdyroom-${roomId}`);
    expect(video.roomJoin).toBe(true);
    expect(video.canPublish).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(video.roomAdmin).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(LIVEKIT_API_SECRET);
  });

  it("answers the same 404 for an outsider and for a room that does not exist", async () => {
    await as(carol);
    const outsider = await mint(roomId, {});
    const missingRoom = await mint(
      "99999999-9999-4999-8999-999999999999",
      {},
    );

    expect(outsider.response.status).toBe(404);
    expect(missingRoom.response.status).toBe(404);
    expect(errorOf(outsider.body).code).toBe("not_found");
    expect(withoutRequestId(outsider.body)).toEqual(
      withoutRequestId(missingRoom.body),
    );
  });

  it("rejects a room id that is not a UUID", async () => {
    await as(bob);
    const { response, body } = await mint("not-a-uuid", {});

    expect(response.status).toBe(400);
    expect(errorOf(body).code).toBe("validation");
  });

  it("answers 503 while the provider is unconfigured", async () => {
    vi.stubEnv("LIVEKIT_URL", "");
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    await as(bob);

    const { response, body } = await mint(roomId, {});

    expect(response.status).toBe(503);
    expect(errorOf(body).code).toBe("meeting_unavailable");

    stubLiveKitEnv();
  });

  it("drops the microphone from a muted member's grant until the mute lifts", async () => {
    await as(alice);
    const muted = await callApiWithParams(
      mutePost,
      {
        path: `/api/rooms/${roomId}/members/${bobAlias}/mute`,
        method: "POST",
        body: { duration: "1h" },
      },
      { id: roomId, alias: bobAlias },
    ).then(async (response) => ({ response, body: await readJson(response) }));
    expect(muted.response.status).toBe(201);

    await as(bob);
    const silenced = await mint(roomId, {});
    expect(silenced.response.status).toBe(200);
    expect(silenced.body.can_publish_mic).toBe(false);
    const claims = decodeClaims(String(silenced.body.token));
    const video = claims.video as Record<string, unknown>;
    expect(video.canPublishSources).toEqual(["camera", "screen_share"]);

    await as(alice);
    const lifted = await callApiWithParams(
      muteDelete,
      {
        path: `/api/rooms/${roomId}/members/${bobAlias}/mute`,
        method: "DELETE",
      },
      { id: roomId, alias: bobAlias },
    ).then(async (response) => ({ response, body: await readJson(response) }));
    expect(lifted.body).toEqual({ unmuted: true });
    expect(lifted.response.status).toBe(200);
  });

  it("rate-limits after the documented burst on one room and user", async () => {
    await as(dave);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { response } = await mint(daveRoomId, {});
      expect(response.status).toBe(200);
    }

    const limited = await mint(daveRoomId, {});
    expect(limited.response.status).toBe(429);
    expect(errorOf(limited.body).code).toBe("rate_limited");
    expect(limited.response.headers.get("Retry-After")).toBe("60");
  });
});
