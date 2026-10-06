import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as endPost } from "@/app/api/rooms/[id]/session/end/route";
import { POST as pausePost } from "@/app/api/rooms/[id]/session/pause/route";
import { POST as resumePost } from "@/app/api/rooms/[id]/session/resume/route";
import { POST as startPost } from "@/app/api/rooms/[id]/session/start/route";
import { GET as workspaceGet } from "@/app/api/rooms/[id]/workspace/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql } from "./helpers/admin";
import { callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Session = {
  id: string;
  room_id: string;
  state: "running" | "paused" | "completed" | "expired";
  duration_seconds: number;
  started_at: string;
  ends_at: string;
  paused_at: string | null;
  paused_seconds: number;
  ended_at: string | null;
};

type StartBody = { action: string; session: Session };

function assertUuid(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`Refusing to interpolate a malformed id: ${value}`);
  }
  return value;
}

/** Rows of the table the API must be the only writer of. */
function activeRows(roomId: string): number {
  return Number(
    psql(
      `select count(*) from public.focus_sessions ` +
        `where room_id = '${assertUuid(roomId)}' and state in ('running','paused');`,
    ),
  );
}

function sessionFacts(sessionId: string): string {
  return psql(
    `select state || '|' || (ended_at = ends_at)::text ` +
      `from public.focus_sessions where id = '${assertUuid(sessionId)}';`,
  );
}

/**
 * Time passing for a row nobody's browser is watching. `started_at` moves
 * back too, so the deadline lands in the past without violating the schema's
 * `ends_at > started_at` check.
 */
function backdateActiveDeadline(roomId: string): void {
  psql(
    `update public.focus_sessions ` +
      `set started_at = now() - interval '2 seconds', ` +
      `    ends_at = now() - interval '1 second' ` +
      `where room_id = '${assertUuid(roomId)}' and state in ('running','paused');`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("shared focus sessions", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let roomId: string;

  beforeAll(async () => {
    [owner, member, outsider] = await Promise.all([
      createUser("focus-owner"),
      createUser("focus-member"),
      createUser("focus-outsider"),
    ]);

    await Promise.all(
      [owner, member, outsider].map((user, index) =>
        createProfile(user.client, user.id, uniqueAlias(`F${index}`)),
      ),
    );

    roomId = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Focus"), capacity: 4 }),
      )
    ).id;
    await joinRoom(member.client, roomId);
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([owner, member, outsider]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function workspace(roomIdArg: string = roomId) {
    return callApiWithParams(
      workspaceGet,
      { path: `/api/rooms/${roomIdArg}/workspace` },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function control(
    handler: typeof startPost,
    name: "start" | "pause" | "resume" | "end",
    body: unknown,
    roomIdArg: string = roomId,
  ) {
    return callApiWithParams(
      handler,
      {
        path: `/api/rooms/${roomIdArg}/session/${name}`,
        method: "POST",
        body,
      },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  const start = (body: unknown = { duration_seconds: 300 }) =>
    control(startPost, "start", body);
  const pause = (body: unknown = {}, roomIdArg: string = roomId) =>
    control(pausePost, "pause", body, roomIdArg);
  const resume = (body: unknown = {}) => control(resumePost, "resume", body);
  const end = (body: unknown = {}) => control(endPost, "end", body);

  describe("workspace reads", () => {
    it("answers 401 to an anonymous reader", async () => {
      clearCookies();
      const { response, body } = await workspace();

      expect(response.status).toBe(401);
      expect(errorOf(body).code).toBe("unauthenticated");
    });

    it("answers the same 404 for a non-member and for a room that does not exist", async () => {
      await as(outsider);

      const missing = await workspace(
        "99999999-9999-4999-8999-999999999999",
      );
      const foreign = await workspace();

      expect(missing.response.status).toBe(404);
      expect(foreign.response.status).toBe(404);
      expect(errorOf(missing.body).code).toBe("not_found");
      expect(errorOf(foreign.body).code).toBe("not_found");
      expect(JSON.stringify(missing.body)).toBe(JSON.stringify(foreign.body));
    });

    it("rejects a room id that is not a UUID", async () => {
      await as(member);
      const { response, body } = await workspace("not-a-uuid");

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("validation");
    });

    it("gives each member their own role, the seat count and the server clock", async () => {
      await as(owner);
      const asOwner = await workspace();
      await as(member);
      const asMember = await workspace();

      expect(asOwner.response.status).toBe(200);
      expect(asOwner.body.viewer_role).toBe("owner");
      expect(asMember.body.viewer_role).toBe("student");
      expect(asMember.body.member_count).toBe(2);
      expect(typeof asMember.body.server_now_ms).toBe("number");
      expect((asMember.body.room as { name: string }).name).toBeTruthy();
      expect(asMember.body.session).toBeNull();
      expect(asMember.body.history).toEqual([]);
    });
  });

  describe("starting", () => {
    it("validates the duration before touching the database", async () => {
      await as(owner);

      for (const body of [
        { duration_seconds: 30 },
        { duration_seconds: 7201 },
        { duration_seconds: 60.5 },
        {},
        { duration_seconds: 300, started_at: "2026-01-01T00:00:00Z" },
      ]) {
        const { response, body: parsed } = await start(body);
        expect(response.status).toBe(400);
        expect(errorOf(parsed).code).toBe("validation");
      }
      expect(activeRows(roomId)).toBe(0);
    });

    it("refuses an anonymous start with 401", async () => {
      clearCookies();
      const { response } = await start();

      expect(response.status).toBe(401);
      expect(activeRows(roomId)).toBe(0);
    });

    it("refuses a non-member with 404 and a member who is not the owner with 403", async () => {
      await as(outsider);
      const outsiderStart = await start();
      expect(outsiderStart.response.status).toBe(404);
      expect(errorOf(outsiderStart.body).code).toBe("not_found");

      await as(member);
      const memberStart = await start();
      expect(memberStart.response.status).toBe(403);
      expect(errorOf(memberStart.body).code).toBe("not_owner");
      expect(activeRows(roomId)).toBe(0);
    });

    it("starts a server-timed session the owner can see", async () => {
      await as(owner);
      const { response, body } = await start({ duration_seconds: 300 });

      expect(response.status).toBe(201);
      const started = body as StartBody;
      expect(started.action).toBe("started");
      expect(started.session.state).toBe("running");
      expect(started.session.room_id).toBe(roomId);
      expect(started.session.duration_seconds).toBe(300);
      expect(Date.parse(started.session.ends_at)).toBeGreaterThanOrEqual(
        Date.parse(started.session.started_at) + 300_000 - 1_000,
      );
      expect(activeRows(roomId)).toBe(1);
    });

    it("shows the running session to every member, with their own role", async () => {
      await as(member);
      const { response, body } = await workspace();

      expect(response.status).toBe(200);
      expect((body.session as Session).state).toBe("running");
      expect(body.viewer_role).toBe("student");
      expect(body.member_count).toBe(2);
    });

    it("answers a repeat start with the session already going", async () => {
      await as(owner);
      const first = await workspace();
      const { response, body } = await start();

      expect(response.status).toBe(200);
      const again = body as StartBody;
      expect(again.action).toBe("already_active");
      expect(again.session.id).toBe((first.body.session as Session).id);
      expect(activeRows(roomId)).toBe(1);
    });

    it("lets one winner through a concurrent race of starts", async () => {
      await as(owner);
      expect((await end()).response.status).toBe(200);
      expect(activeRows(roomId)).toBe(0);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => start({ duration_seconds: 600 })),
      );

      const statuses = results.map((result) => result.response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(5);

      const sessions = results.map(
        (result) => (result.body as StartBody).session.id,
      );
      expect(new Set(sessions).size).toBe(1);
      expect(
        results
          .map((result) => (result.body as StartBody).action)
          .filter((action) => action === "already_active"),
      ).toHaveLength(5);
      expect(activeRows(roomId)).toBe(1);
    });
  });

  describe("direct writes are refused", () => {
    it("denies an authenticated INSERT, so a session can only start through the RPC", async () => {
      const { error } = await member.client.from("focus_sessions").insert({
        room_id: roomId,
        state: "running",
        duration_seconds: 60,
        ends_at: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(activeRows(roomId)).toBe(1);
    });

    it("denies an authenticated UPDATE, so a deadline cannot be rewound", async () => {
      const listed = await member.client
        .from("focus_sessions")
        .select("id")
        .eq("room_id", roomId)
        .in("state", ["running", "paused"]);
      expect(listed.data).toHaveLength(1);
      const targetId = String((listed.data ?? [])[0]?.id ?? "");

      const { error } = await member.client
        .from("focus_sessions")
        .update({ ends_at: new Date(Date.now() + 7_200_000).toISOString() })
        .eq("id", targetId);

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
    });

    it("lets a member read sessions but shows a non-member nothing", async () => {
      const memberRows = await member.client
        .from("focus_sessions")
        .select("id, state, ended_at, paused_seconds")
        .eq("room_id", roomId);
      expect(memberRows.error).toBeNull();
      const roomRows = Number(
        psql(
          `select count(*) from public.focus_sessions ` +
            `where room_id = '${assertUuid(roomId)}';`,
        ),
      );
      expect(memberRows.data).toHaveLength(roomRows);

      const outsiderRows = await outsider.client
        .from("focus_sessions")
        .select("id")
        .eq("room_id", roomId);
      expect(outsiderRows.error).toBeNull();
      expect(outsiderRows.data).toEqual([]);
    });
  });

  describe("pause, resume and end", () => {
    it("refuses controls from a member who is not the owner", async () => {
      await as(member);
      for (const result of [await pause(), await resume(), await end()]) {
        expect(result.response.status).toBe(403);
        expect(errorOf(result.body).code).toBe("not_owner");
      }
      expect(activeRows(roomId)).toBe(1);
    });

    it("refuses controls when there is nothing running", async () => {
      await as(owner);
      expect((await end()).response.status).toBe(200);
      expect(activeRows(roomId)).toBe(0);

      for (const result of [await pause(), await resume(), await end()]) {
        expect(result.response.status).toBe(409);
        expect(errorOf(result.body).code).toBe("no_active_session");
      }
    });

    it("rejects a control body that carries fields", async () => {
      const { response, body } = await pause({ forced: true });

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("invalid_request");
    });

    it("freezes the deadline while paused and credits the pause back on resume", async () => {
      await as(owner);
      const started = (await start({ duration_seconds: 900 })).body as StartBody;
      const paused = (await pause()).body as StartBody;

      expect(paused.action).toBe("paused");
      expect(paused.session.state).toBe("paused");
      expect(paused.session.paused_at).not.toBeNull();
      expect(paused.session.ends_at).toBe(started.session.ends_at);

      await sleep(1_200);

      const resumed = (await resume()).body as StartBody;
      expect(resumed.action).toBe("resumed");
      expect(resumed.session.state).toBe("running");
      expect(resumed.session.paused_at).toBeNull();
      expect(
        Date.parse(resumed.session.ends_at) - Date.parse(paused.session.ends_at),
      ).toBeGreaterThanOrEqual(1_000);
      expect(resumed.session.paused_seconds).toBeGreaterThanOrEqual(1);

      const invalid = await resume();
      expect(invalid.response.status).toBe(409);
      expect(errorOf(invalid.body).code).toBe("invalid_state");
    });

    it("completes on an early end and reports it in the workspace history", async () => {
      await as(owner);
      const completed = (await end()).body as StartBody;

      expect(completed.action).toBe("completed");
      expect(completed.session.state).toBe("completed");
      expect(completed.session.ended_at).not.toBeNull();

      const { body } = await workspace();
      expect(body.session).toBeNull();
      const history = body.history as Session[];
      expect(history.some((entry) => entry.id === completed.session.id)).toBe(true);
    });

    it("keeps history ordered newest first with only terminal sessions", async () => {
      await as(owner);
      for (const seconds of [60, 60, 60]) {
        expect((await start({ duration_seconds: seconds })).response.status).toBe(201);
        expect((await end()).response.status).toBe(200);
      }

      const { body } = await workspace();
      const history = body.history as Session[];
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history.every((entry) => entry.state === "completed")).toBe(true);
      for (let index = 1; index < history.length; index += 1) {
        const previous = String(history[index - 1].ended_at);
        const current = String(history[index].ended_at);
        expect(previous >= current).toBe(true);
      }
      expect(activeRows(roomId)).toBe(0);
    });
  });

  describe("expiry without a browser", () => {
    it("persists a passed deadline on the next read and does not block a new start", async () => {
      await as(owner);
      const stale = (await start({ duration_seconds: 60 })).body as StartBody;
      backdateActiveDeadline(roomId);

      // Nothing was open: the first reader records the expiry.
      const refused = await pause();
      expect(refused.response.status).toBe(409);
      expect(errorOf(refused.body).code).toBe("no_active_session");

      const facts = sessionFacts(stale.session.id);
      expect(facts).toBe("expired|true");

      const { body } = await workspace();
      expect(body.session).toBeNull();
      const history = body.history as Session[];
      const expired = history.find((entry) => entry.id === stale.session.id);
      expect(expired?.state).toBe("expired");
      expect(expired?.ended_at).toBe(expired?.ends_at);

      // The stale row does not block the room.
      const restarted = await start({ duration_seconds: 120 });
      expect(restarted.response.status).toBe(201);
      expect((restarted.body as StartBody).session.id).not.toBe(stale.session.id);
      expect(activeRows(roomId)).toBe(1);
    });
  });
});
