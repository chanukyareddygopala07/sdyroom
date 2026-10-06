import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DELETE as goalDelete } from "@/app/api/goals/[goalId]/route";
import { PATCH as goalPatch } from "@/app/api/goals/[goalId]/route";
import { GET as goalsGet, POST as goalsPost } from "@/app/api/rooms/[id]/goals/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql } from "./helpers/admin";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Goal = {
  id: string;
  room_id: string;
  title: string;
  target_seconds: number | null;
  target_count: number | null;
  status: "active" | "completed";
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

function anonClient(): SupabaseClient {
  const { apiUrl, publishableKey } = integrationEnv();
  return createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Goal rows for one user, ignoring RLS — the privacy assertions' oracle. */
function goalTitlesOwnedBy(userId: string): string[] {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Refusing to query a malformed user id: ${userId}`);
  }
  const output = psql(
    `select title from public.study_goals where user_id = '${userId}' order by created_at;`,
  );
  return output === "" ? [] : output.split("\n");
}

describe("personal study goals", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let roomId: string;
  let foreignRoomId: string;

  beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([
      createUser("goals-alice"),
      createUser("goals-bob"),
      createUser("goals-carol"),
    ]);

    await Promise.all(
      [alice, bob, carol].map((user, index) =>
        createProfile(user.client, user.id, uniqueAlias(`G${index}`)),
      ),
    );

    roomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("Goals"), capacity: 4 }),
      )
    ).id;
    foreignRoomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("Away"), capacity: 4 }),
      )
    ).id;
    await joinRoom(bob.client, roomId);
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([alice, bob, carol]);
    // Cascade: a deleted account takes its personal goals with it.
    expect(goalTitlesOwnedBy(alice.id)).toEqual([]);
    expect(goalTitlesOwnedBy(bob.id)).toEqual([]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function listGoals(roomIdArg: string = roomId) {
    return callApiWithParams(
      goalsGet,
      { path: `/api/rooms/${roomIdArg}/goals` },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function createGoal(body: unknown, roomIdArg: string = roomId) {
    return callApiWithParams(
      goalsPost,
      {
        path: `/api/rooms/${roomIdArg}/goals`,
        method: "POST",
        body,
      },
      { id: roomIdArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function patchGoal(body: unknown, goalId: string) {
    return callApiWithParams(
      goalPatch,
      { path: `/api/goals/${goalId}`, method: "PATCH", body },
      { goalId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function deleteGoal(goalId: string) {
    return callApiWithParams(
      goalDelete,
      { path: `/api/goals/${goalId}`, method: "DELETE" },
      { goalId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  describe("request guards", () => {
    it("answers 401 to an anonymous reader or writer", async () => {
      clearCookies();

      const read = await listGoals();
      expect(read.response.status).toBe(401);
      expect(errorOf(read.body).code).toBe("unauthenticated");

      const write = await createGoal({ title: "Anything" });
      expect(write.response.status).toBe(401);
      expect(goalTitlesOwnedBy(bob.id)).toEqual([]);
    });

    it("answers the same 404 to a non-member for reads and writes", async () => {
      await as(carol);

      const read = await listGoals();
      const write = await createGoal({ title: "Anything" });

      expect(read.response.status).toBe(404);
      expect(write.response.status).toBe(404);
      expect(errorOf(read.body).code).toBe("not_found");
      expect(errorOf(write.body).code).toBe("not_found");
      expect(goalTitlesOwnedBy(carol.id)).toEqual([]);
    });

    it("rejects a room id that is not a UUID", async () => {
      await as(bob);
      const { response, body } = await listGoals("not-a-uuid");

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("validation");
    });

    it("rejects goals the client should never choose", async () => {
      await as(bob);

      for (const invalid of [
        { title: "   " },
        { title: "x".repeat(121) },
        { title: "Short", target_seconds: 30 },
        { title: "Short", target_seconds: 86_401 },
        { title: "Short", target_count: 0 },
        { title: "Short", user_id: alice.id },
        { title: "Short", completed_at: "2020-01-01T00:00:00Z" },
      ]) {
        const { response, body } = await createGoal(invalid);
        expect(response.status).toBe(400);
        expect(errorOf(body).code).toBe("validation");
      }
      expect(goalTitlesOwnedBy(bob.id)).toEqual([]);
    });
  });

  describe("creating and listing", () => {
    it("creates a goal without accepting or exposing an owner id", async () => {
      await as(bob);
      const { response, body } = await createGoal({
        title: "Finish chapter 4",
        target_seconds: 1500,
        target_count: 10,
      });

      expect(response.status).toBe(201);
      const goal = body.goal as Goal;
      expect(goal.title).toBe("Finish chapter 4");
      expect(goal.target_seconds).toBe(1500);
      expect(goal.target_count).toBe(10);
      expect(goal.status).toBe("active");
      expect(goal.room_id).toBe(roomId);
      expect(goal.completed_at).toBeNull();
      expect(Object.keys(goal)).not.toContain("user_id");
      expect(goalTitlesOwnedBy(bob.id)).toEqual(["Finish chapter 4"]);
    });

    it("never shows one member's goals to another in the same room", async () => {
      await as(alice);
      const { response, body } = await listGoals();

      expect(response.status).toBe(200);
      expect(body.goals).toEqual([]);

      await as(bob);
      const bobs = await listGoals();
      expect((bobs.body.goals as Goal[]).map((goal) => goal.title)).toEqual([
        "Finish chapter 4",
      ]);
    });

    it("answers 409 for a duplicate active title and frees it once completed", async () => {
      await as(bob);
      const duplicate = await createGoal({ title: "finish chapter 4" });
      expect(duplicate.response.status).toBe(409);
      expect(errorOf(duplicate.body).code).toBe("duplicate_goal");

      const listed = (await listGoals()).body.goals as Goal[];
      const goal = listed.find((entry) => entry.title === "Finish chapter 4");
      expect(goal).toBeTruthy();

      const completed = await patchGoal({ status: "completed" }, String(goal?.id));
      expect(completed.response.status).toBe(200);

      const reused = await createGoal({ title: "finish chapter 4" });
      expect(reused.response.status).toBe(201);
      expect(((reused.body.goal as Goal).title)).toBe("finish chapter 4");
    });
  });

  describe("editing and deleting", () => {
    it("edits fields the client may write and nothing else", async () => {
      await as(bob);
      const listed = (await listGoals()).body.goals as Goal[];
      const goal = listed.find((entry) => entry.status === "completed");
      expect(goal).toBeTruthy();
      const goalId = String(goal?.id);

      const renamed = await patchGoal(
        { title: "Finish chapter 4, part 2", target_count: 20 },
        goalId,
      );
      expect(renamed.response.status).toBe(200);
      expect((renamed.body.goal as Goal).title).toBe("Finish chapter 4, part 2");
      expect((renamed.body.goal as Goal).target_count).toBe(20);

      const empty = await patchGoal({}, goalId);
      expect(empty.response.status).toBe(400);
      expect(errorOf(empty.body).code).toBe("invalid_request");

      const forged = await patchGoal(
        { user_id: alice.id, completed_at: "2020-01-01T00:00:00Z" },
        goalId,
      );
      expect(forged.response.status).toBe(400);
      expect(errorOf(forged.body).code).toBe("validation");

      const badId = await patchGoal({ title: "x" }, "not-a-uuid");
      expect(badId.response.status).toBe(400);
    });

    it("timestamps completion through the database, never the client", async () => {
      await as(bob);
      const listed = (await listGoals()).body.goals as Goal[];
      const goal = listed.find((entry) => entry.status === "completed");
      expect(goal).toBeTruthy();
      const goalId = String(goal?.id);

      const reopened = await patchGoal({ status: "active" }, goalId);
      expect(reopened.response.status).toBe(200);
      expect((reopened.body.goal as Goal).status).toBe("active");
      expect((reopened.body.goal as Goal).completed_at).toBeNull();

      const completed = await patchGoal({ status: "completed" }, goalId);
      expect(completed.response.status).toBe(200);
      expect((completed.body.goal as Goal).completed_at).not.toBeNull();
    });

    it("gives another member the same 404 as a goal that never existed", async () => {
      await as(alice);
      const created = await createGoal({ title: "Alice private plan" });
      expect(created.response.status).toBe(201);
      const aliceGoalId = (created.body.goal as Goal).id;

      await as(bob);
      const patched = await patchGoal({ title: "Hijacked" }, aliceGoalId);
      const removed = await deleteGoal(aliceGoalId);

      expect(patched.response.status).toBe(404);
      expect(errorOf(patched.body).code).toBe("not_found");
      expect(removed.response.status).toBe(404);

      await as(alice);
      const stillThere = await listGoals();
      expect((stillThere.body.goals as Goal[]).map((goal) => goal.title)).toContain(
        "Alice private plan",
      );
      expect(goalTitlesOwnedBy(alice.id)).toEqual(["Alice private plan"]);
    });

    it("deletes the caller's goal and stops listing it", async () => {
      await as(alice);
      const goal = ((await listGoals()).body.goals as Goal[])[0];

      const removed = await deleteGoal(goal.id);
      expect(removed.response.status).toBe(200);
      expect(removed.body.deleted).toBe(true);

      const { body } = await listGoals();
      expect(body.goals).toEqual([]);
      expect(goalTitlesOwnedBy(alice.id)).toEqual([]);

      const again = await deleteGoal(goal.id);
      expect(again.response.status).toBe(404);
    });
  });

  describe("direct writes are refused or narrowed", () => {
    it("refuses a forged owner id on insert", async () => {
      const { error } = await bob.client.from("study_goals").insert({
        user_id: alice.id,
        room_id: roomId,
        title: "Not mine to claim",
        target_seconds: 600,
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(goalTitlesOwnedBy(alice.id)).toEqual([]);
    });

    it("refuses a goal attached to a room the writer has not joined", async () => {
      const { error } = await bob.client.from("study_goals").insert({
        user_id: bob.id,
        room_id: foreignRoomId,
        title: "Wrong room",
        target_seconds: 600,
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(goalTitlesOwnedBy(bob.id)).not.toContain("Wrong room");
    });

    it("refuses moving a goal to another user or room", async () => {
      await as(bob);
      const goals = (await listGoals()).body.goals as Goal[];
      const goal = goals[0];
      expect(goal).toBeTruthy();
      const goalId = String(goal?.id);

      const stolen = await bob.client
        .from("study_goals")
        .update({ user_id: alice.id })
        .eq("id", goalId);
      expect(stolen.error).not.toBeNull();
      expect(stolen.error?.code).toBe("42501");

      const moved = await bob.client
        .from("study_goals")
        .update({ room_id: foreignRoomId })
        .eq("id", goalId);
      expect(moved.error).not.toBeNull();
      expect(moved.error?.code).toBe("42501");
    });

    it("lets the owner edit allowed columns directly, with the trigger intact", async () => {
      await as(bob);
      const goals = (await listGoals()).body.goals as Goal[];
      const goalId = String(goals[0]?.id);

      const edited = await bob.client
        .from("study_goals")
        .update({ title: "Edited straight through RLS" })
        .eq("id", goalId)
        .select();
      expect(edited.error).toBeNull();
      expect((edited.data as Goal[])[0]?.title).toBe("Edited straight through RLS");

      const completed = await bob.client
        .from("study_goals")
        .update({ status: "completed" })
        .eq("id", goalId)
        .select();
      expect(completed.error).toBeNull();
      expect((completed.data as Goal[])[0]?.completed_at).not.toBeNull();
    });

    it("denies the table to anonymous clients entirely", async () => {
      const anon = anonClient();

      const read = await anon.from("study_goals").select("id");
      expect(read.error).not.toBeNull();

      const write = await anon.from("study_goals").insert({
        user_id: bob.id,
        room_id: roomId,
        title: "Anonymous attempt",
      });
      expect(write.error).not.toBeNull();
      expect(goalTitlesOwnedBy(bob.id)).not.toContain("Anonymous attempt");
    });
  });
});
