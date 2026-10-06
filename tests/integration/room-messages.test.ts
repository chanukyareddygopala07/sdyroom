import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GET as messagesGet,
  POST as messagesPost,
} from "@/app/api/rooms/[id]/messages/route";
import { CHAT_MESSAGE_MAX_LENGTH } from "@/lib/chat/types";
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
const MISSING_ROOM_ID = "00000000-0000-4000-8000-000000000000";

type Message = {
  id: string;
  alias: string;
  body: string;
  created_at: string;
  status: "sent";
  is_own: boolean;
};

/** Rows for one room, ignoring RLS — the privacy assertions' oracle. */
function messageBodiesIn(roomId: string): string[] {
  if (!UUID_RE.test(roomId)) {
    throw new Error(`Refusing to query a malformed room id: ${roomId}`);
  }
  const output = psql(
    `select body from public.room_messages where room_id = '${roomId}' order by seq;`,
  );
  return output === "" ? [] : output.split("\n");
}

describe("room messages", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let roomId: string;
  let foreignRoomId: string;
  let aliceAlias: string;
  let bobAlias: string;

  beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([
      createUser("messages-alice"),
      createUser("messages-bob"),
      createUser("messages-carol"),
    ]);

    const registered = await Promise.all(
      [alice, bob, carol].map(async (user, index) => {
        const alias = uniqueAlias(`M${index}`);
        await createProfile(user.client, user.id, alias);
        return alias;
      }),
    );
    aliceAlias = registered[0];
    bobAlias = registered[1];

    roomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("Messages"), capacity: 4 }),
      )
    ).id;
    await joinRoom(bob.client, roomId);

    foreignRoomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("Away"), capacity: 4 }),
      )
    ).id;
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([alice, bob, carol]);
    // Cascade: a deleted account takes its messages with it.
    expect(messageBodiesIn(roomId)).toEqual([]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function getMessages(query = "", roomIdArg: string = roomId) {
    return callApiWithParams(
      messagesGet,
      { path: `/api/rooms/${roomIdArg}/messages${query}` },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function postMessage(body: unknown, roomIdArg: string = roomId) {
    return callApiWithParams(
      messagesPost,
      { path: `/api/rooms/${roomIdArg}/messages`, method: "POST", body },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function messageOf(body: Record<string, unknown>): Message {
    const message = body.message;
    if (!message || typeof message !== "object") {
      throw new Error(`Expected { message: ... }, got ${JSON.stringify(body)}`);
    }
    return message as Message;
  }

  describe("sending", () => {
    it("stamps the caller's own alias and never returns sender ids", async () => {
      await as(alice);
      const { response, body } = await postMessage({ body: "Hello room" });

      expect(response.status).toBe(201);
      const message = messageOf(body);
      expect(message.id).toMatch(UUID_RE);
      expect(message.alias).toBe(aliceAlias);
      expect(message.body).toBe("Hello room");
      expect(message.status).toBe("sent");
      expect(message.is_own).toBe(true);
      expect(message.created_at).toBeTruthy();
      expect("user_id" in message).toBe(false);
      expect("room_id" in message).toBe(false);
      expect("seq" in message).toBe(false);
    });

    it("rejects an empty, blank, or over-long body", async () => {
      await as(alice);

      for (const invalid of [
        { body: "" },
        { body: "   " },
        { body: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) },
      ]) {
        const { response, body } = await postMessage(invalid);
        expect(response.status).toBe(400);
        expect(errorOf(body).code).toBe("validation");
      }
    });

    it("rejects fields the client must never choose", async () => {
      await as(alice);

      const forged = await postMessage({
        body: "trustworthy",
        user_id: carol.id,
        alias: "NotMine",
      });
      expect(forged.response.status).toBe(400);
      expect(errorOf(forged.body).code).toBe("validation");
    });

    it("rejects a body that is not JSON", async () => {
      await as(alice);
      const { response, body } = await callApiWithParams(
        messagesPost,
        {
          path: `/api/rooms/${roomId}/messages`,
          method: "POST",
          rawBody: "not json",
        },
        { id: roomId },
      ).then(async (result) => ({ response: result, body: await readJson(result) }));

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("invalid_json");
    });

    it("pins the alias at send time, so a rename cannot rewrite history", async () => {
      await as(bob);
      const sent = await postMessage({ body: "before rename" });
      expect(sent.response.status).toBe(201);
      expect(messageOf(sent.body).alias).toBe(bobAlias);

      const renamed = uniqueAlias("Renamed");
      const { error } = await bob.client
        .from("profiles")
        .update({ alias: renamed })
        .eq("id", bob.id);
      expect(error).toBeNull();
      expect(renamed).not.toBe(bobAlias);

      const { response, body } = await getMessages();
      expect(response.status).toBe(200);
      const row = (body.messages as Message[]).find(
        (item) => item.body === "before rename",
      );
      expect(row?.alias).toBe(bobAlias);
    });
  });

  describe("reading history", () => {
    it("returns messages oldest-first with viewer-relative is_own", async () => {
      await as(alice);
      const { response, body } = await getMessages();

      expect(response.status).toBe(200);
      expect(body.has_more).toBe(false);
      const history = body.messages as Message[];
      expect(history.length).toBeGreaterThanOrEqual(2);

      for (const item of history) {
        expect(item.is_own).toBe(item.alias === aliceAlias);
      }

      const timestamps = history.map((item) => item.created_at);
      expect([...timestamps].sort()).toEqual(timestamps);

      // The same rows for every member; only `is_own` flips with the viewer.
      await as(bob);
      const bobView = (await getMessages()).body.messages as Message[];
      expect(bobView.map((item) => item.id)).toEqual(
        history.map((item) => item.id),
      );
      const bobOwn = bobView.filter((item) => item.is_own);
      expect(bobOwn.length).toBeGreaterThan(0);
      for (const item of bobOwn) {
        expect(item.alias).toBe(bobAlias);
      }
      expect(
        bobView.filter((item) => item.alias === aliceAlias).every(
          (item) => !item.is_own,
        ),
      ).toBe(true);
    });

    it("pages with the `before` cursor without gaps or repeats", async () => {
      await as(alice);
      for (const text of ["page one", "page two", "page three"]) {
        const { response } = await postMessage({ body: text });
        expect(response.status).toBe(201);
      }

      const newest = await getMessages("?limit=2");
      expect(newest.response.status).toBe(200);
      expect(newest.body.has_more).toBe(true);
      const top = newest.body.messages as Message[];
      expect(top.map((item) => item.body)).toEqual([
        "page two",
        "page three",
      ]);

      const older = await getMessages(`?limit=2&before=${top[0].id}`);
      expect(older.response.status).toBe(200);
      expect(older.body.has_more).toBe(true);
      const bottom = older.body.messages as Message[];
      expect(bottom.map((item) => item.body)).toEqual([
        "before rename",
        "page one",
      ]);
      const seen = new Set([...top, ...bottom].map((item) => item.id));
      expect(seen.size).toBe(top.length + bottom.length);

      const oldest = await getMessages(`?limit=10&before=${bottom[0].id}`);
      expect(oldest.response.status).toBe(200);
      const rest = oldest.body.messages as Message[];
      expect(rest.map((item) => item.body)).toEqual(["Hello room"]);
      expect(rest.some((item) => seen.has(item.id))).toBe(false);
      expect(oldest.body.has_more).toBe(false);
    });

    it("rejects a malformed cursor or page size", async () => {
      await as(alice);

      for (const query of [
        "?before=not-a-uuid",
        "?limit=0",
        "?limit=101",
        "?limit=abc",
      ]) {
        const { response, body } = await getMessages(query);
        expect(response.status).toBe(400);
        expect(errorOf(body).code).toBe("validation");
      }
    });

    it("rejects a well-formed cursor that names a message in another room", async () => {
      await as(alice);
      const foreign = await postMessage({ body: "elsewhere" }, foreignRoomId);
      expect(foreign.response.status).toBe(201);
      const foreignId = messageOf(foreign.body).id;

      const { response, body } = await getMessages(`?before=${foreignId}`);
      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("validation");
      expect(errorOf(body).message).toContain("cursor");
    });

    it("orders by insert sequence even when two messages share a timestamp", async () => {
      await as(alice);
      const twinRoom = (
        await createRoom(
          alice.client,
          createRoomSchema.parse({ name: uniqueName("Twins"), capacity: 4 }),
        )
      ).id;

      const shared = "2026-09-01T12:00:00+00:00";
      psql(
        `insert into public.room_messages (room_id, user_id, alias, body, created_at) values ` +
          `('${twinRoom}', '${alice.id}', 'Twin', 'older twin', '${shared}'), ` +
          `('${twinRoom}', '${alice.id}', 'Twin', 'newer twin', '${shared}');`,
      );

      const newest = await getMessages("?limit=1", twinRoom);
      expect(newest.response.status).toBe(200);
      expect(newest.body.has_more).toBe(true);
      const top = newest.body.messages as Message[];
      expect(top).toHaveLength(1);
      expect(top[0].body).toBe("newer twin");

      const older = await getMessages(
        `?limit=1&before=${top[0].id}`,
        twinRoom,
      );
      const bottom = older.body.messages as Message[];
      expect(bottom.map((item) => item.body)).toEqual(["older twin"]);
    });
  });

  describe("access guards", () => {
    it("answers 401 to an anonymous reader or writer", async () => {
      clearCookies();

      const read = await getMessages();
      expect(read.response.status).toBe(401);
      expect(errorOf(read.body).code).toBe("unauthenticated");

      const write = await postMessage({ body: "anything" });
      expect(write.response.status).toBe(401);
      expect(errorOf(write.body).code).toBe("unauthenticated");
    });

    it("answers the same 404 to a non-member for reads and writes", async () => {
      await as(carol);

      const foreignRead = await getMessages("", foreignRoomId);
      const foreignWrite = await postMessage(
        { body: "should not land" },
        foreignRoomId,
      );
      const missingRead = await getMessages("", MISSING_ROOM_ID);
      const missingWrite = await postMessage(
        { body: "should not land" },
        MISSING_ROOM_ID,
      );

      for (const outcome of [
        foreignRead,
        foreignWrite,
        missingRead,
        missingWrite,
      ]) {
        expect(outcome.response.status).toBe(404);
        expect(errorOf(outcome.body).code).toBe("not_found");
      }

      // Indistinguishable bodies: the URL never reveals which rooms exist.
      expect(errorOf(foreignRead.body)).toEqual(errorOf(missingRead.body));
      expect(errorOf(foreignWrite.body)).toEqual(errorOf(missingWrite.body));

      // The rejected writes never landed (the room may already hold messages
      // its own members posted through the API).
      expect(messageBodiesIn(foreignRoomId)).not.toContain(
        "should not land",
      );
      expect(messageBodiesIn(MISSING_ROOM_ID)).toEqual([]);
    });

    it("rejects a room id that is not a UUID", async () => {
      await as(alice);

      const read = await getMessages("", "not-a-uuid");
      expect(read.response.status).toBe(400);
      expect(errorOf(read.body).code).toBe("validation");

      const write = await postMessage({ body: "hi" }, "not-a-uuid");
      expect(write.response.status).toBe(400);
      expect(errorOf(write.body).code).toBe("validation");
    });
  });

  describe("database contract", () => {
    it("lets members read directly, and no one else see the rows", async () => {
      const { data: memberRows, error: memberError } = await bob.client
        .from("room_messages")
        .select("id, body")
        .eq("room_id", roomId);
      expect(memberError).toBeNull();
      expect((memberRows ?? []).length).toBeGreaterThan(0);

      const { data: outsiderRows, error: outsiderError } = await carol.client
        .from("room_messages")
        .select("id, body")
        .eq("room_id", roomId);
      expect(outsiderError).toBeNull();
      expect(outsiderRows).toEqual([]);
    });

    it("refuses a direct insert that forges the sender", async () => {
      const { error } = await bob.client.from("room_messages").insert({
        room_id: roomId,
        user_id: alice.id,
        alias: "Alice",
        body: "forged sender",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(messageBodiesIn(roomId)).not.toContain("forged sender");
    });

    it("refuses an insert into a room the caller does not belong to", async () => {
      const { error } = await carol.client.from("room_messages").insert({
        room_id: foreignRoomId,
        user_id: carol.id,
        alias: "Carol",
        body: "outsider write",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(messageBodiesIn(foreignRoomId)).not.toContain("outsider write");
    });

    it("grants no UPDATE or DELETE, so history cannot be edited", async () => {
      const existing = messageBodiesIn(roomId);
      expect(existing.length).toBeGreaterThan(0);

      const { data: rows } = await bob.client
        .from("room_messages")
        .select("id")
        .eq("room_id", roomId)
        .limit(1);
      const targetId = rows?.[0]?.id as string;

      const updated = await bob.client
        .from("room_messages")
        .update({ body: "edited in place" })
        .eq("id", targetId);
      expect(updated.error).not.toBeNull();
      expect(updated.error?.code).toBe("42501");

      const deleted = await bob.client
        .from("room_messages")
        .delete()
        .eq("id", targetId);
      expect(deleted.error).not.toBeNull();
      expect(deleted.error?.code).toBe("42501");

      expect(messageBodiesIn(roomId)).toEqual(existing);
    });

    it("publishes the table to realtime for event delivery", () => {
      const count = psql(
        "select count(*) from pg_publication_tables " +
          "where pubname = 'supabase_realtime' " +
          "and schemaname = 'public' and tablename = 'room_messages';",
      );
      expect(count).toBe("1");
    });
  });
});
