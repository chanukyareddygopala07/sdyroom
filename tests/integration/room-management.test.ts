import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as resourcesPost } from "@/app/api/resources/route";
import { DELETE as roomDelete, PATCH as roomPatch } from "@/app/api/rooms/[id]/route";
import { POST as startSessionPost } from "@/app/api/rooms/[id]/session/start/route";
import { createProfile } from "@/lib/profiles/queries";
import {
  acceptInvitation,
  createInvitation,
} from "@/lib/invitations/queries";
import { RESOURCE_BUCKET } from "@/lib/resources/types";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom, MembershipError } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const MISSING_ROOM = "99999999-9999-4999-8999-999999999999";

type RoomRow = {
  name: string;
  owner_id: string;
  capacity: number;
  status: string;
  shared_goal: string | null;
  updated_at: string;
};

describe("room management (edit, lifecycle, delete)", () => {
  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let joiner: TestUser;
  let ownerAlias: string;
  let memberAlias: string;
  let strangerAlias: string;
  let joinerAlias: string;

  let editRoom: string;
  let statusRoom: string;
  let raceRoom: string;
  let victimRoom: string;
  let deleteRoom: string;
  let policyRoom: string;

  let deleteResourceId: string;
  let deleteResourcePath: string;
  let policyPathA: string;
  let policyPathB: string;

  beforeAll(async () => {
    [owner, member, stranger, joiner] = await Promise.all([
      createUser("mgmt-owner"),
      createUser("mgmt-member"),
      createUser("mgmt-stranger"),
      createUser("mgmt-joiner"),
    ]);

    ownerAlias = uniqueAlias("Mo");
    memberAlias = uniqueAlias("Mm");
    strangerAlias = uniqueAlias("Ms");
    joinerAlias = uniqueAlias("Mj");
    await createProfile(owner.client, owner.id, ownerAlias);
    await createProfile(member.client, member.id, memberAlias);
    await createProfile(stranger.client, stranger.id, strangerAlias);
    await createProfile(joiner.client, joiner.id, joinerAlias);

    editRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Edit"), capacity: 4 }),
      )
    ).id;
    await joinRoom(member.client, editRoom);

    statusRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Status"), capacity: 4 }),
      )
    ).id;
    await joinRoom(member.client, statusRoom);

    raceRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Race"), capacity: 2 }),
      )
    ).id;

    victimRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Victim"), capacity: 4 }),
      )
    ).id;
    await joinRoom(member.client, victimRoom);

    // Invitations exist only for private rooms, so the doomed room is private
    // and its membership (and its invitation row) come from the invite flow.
    deleteRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({
          name: uniqueName("Doomed"),
          capacity: 4,
          visibility: "private",
        }),
      )
    ).id;
    const memberInvite = await createInvitation(
      owner.client,
      deleteRoom,
      memberAlias,
      24,
    );
    await acceptInvitation(member.client, memberInvite.id);

    policyRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Policy"), capacity: 4 }),
      )
    ).id;
    await joinRoom(member.client, policyRoom);

    // Dependent rows for the cascade assertion: membership already in place.
    const goal = await member.client
      .from("study_goals")
      .insert({ user_id: member.id, room_id: deleteRoom, title: "Finish chapter" });
    expect(goal.error).toBeNull();

    const message = await member.client.from("room_messages").insert({
      room_id: deleteRoom,
      user_id: member.id,
      alias: memberAlias,
      body: "hello room",
    });
    expect(message.error).toBeNull();

    // focus_sessions takes no direct grant — start one through the API
    // (sessions are owner-started by design).
    await as(owner);
    const session = await callApiWithParams(
      startSessionPost,
      {
        path: `/api/rooms/${deleteRoom}/session/start`,
        method: "POST",
        body: { duration_seconds: 300 },
      },
      { id: deleteRoom },
    );
    expect(session.status).toBe(201);

    await createInvitation(owner.client, deleteRoom, strangerAlias, 24);

    // The trickiest asymmetry: a *member's* upload inside the owner's room.
    deleteResourceId = await uploadInto(deleteRoom);
    deleteResourcePath = storagePathOf(deleteResourceId);

    policyPathA = storagePathOf(await uploadInto(policyRoom, "alpha.pdf"));
    policyPathB = storagePathOf(await uploadInto(policyRoom, "beta.pdf"));
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([owner, member, stranger, joiner]);
  });

  async function uploadInto(roomId: string, filename = "notes.pdf"): Promise<string> {
    await seedSession(member.email, member.password);
    const form = new FormData();
    form.append(
      "file",
      new File(
        [new TextEncoder().encode(`%PDF-1.4\n${filename}\n%%EOF\n`)],
        filename,
        { type: "application/pdf" },
      ),
    );
    form.append("title", filename);
    form.append("room_id", roomId);

    const response = await callApi(resourcesPost, {
      path: "/api/resources",
      method: "POST",
      form,
    });
    expect(response.status).toBe(201);
    return ((await readJson(response)).resource as { id: string }).id;
  }

  function storagePathOf(resourceId: string): string {
    const path = psql(
      `select storage_path from public.study_resources where id = '${resourceId}';`,
    );
    expect(path).toMatch(/^rooms\//);
    return path;
  }

  function storageObjectCount(roomId: string): number {
    return Number(
      psql(
        `select count(*) from storage.objects where name like 'rooms/${roomId}/%';`,
      ),
    );
  }

  function cascadeCounts(roomId: string): Record<string, number> {
    const out = psql(
      `select 'members=' || (select count(*) from public.room_members where room_id = '${roomId}')` +
        ` || ',goals=' || (select count(*) from public.study_goals where room_id = '${roomId}')` +
        ` || ',sessions=' || (select count(*) from public.focus_sessions where room_id = '${roomId}')` +
        ` || ',messages=' || (select count(*) from public.room_messages where room_id = '${roomId}')` +
        ` || ',invites=' || (select count(*) from public.room_invitations where room_id = '${roomId}')` +
        ` || ',resources=' || (select count(*) from public.study_resources where room_id = '${roomId}');`,
    );
    return Object.fromEntries(
      out.split(",").map((pair) => {
        const [key, value] = pair.split("=");
        return [key, Number(value)];
      }),
    );
  }

  async function readRoom(roomId: string): Promise<RoomRow> {
    const { data, error } = await owner.client
      .from("rooms")
      .select("name, owner_id, capacity, status, shared_goal, updated_at")
      .eq("id", roomId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    return data as RoomRow;
  }

  function patch(user: TestUser, roomId: string, body?: unknown) {
    return callApiWithParams(
      roomPatch,
      { path: `/api/rooms/${roomId}`, method: "PATCH", body },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function del(user: TestUser, roomId: string) {
    return callApiWithParams(
      roomDelete,
      { path: `/api/rooms/${roomId}`, method: "DELETE" },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  describe("PATCH: owner gate and identity", () => {
    it("renames the room, moves updated_at through the trigger, and keeps owner_id", async () => {
      const before = await readRoom(editRoom);
      await as(owner);

      const renamed = uniqueName("Renamed");
      const { response, body } = await patch(owner, editRoom, { name: renamed });

      expect(response.status).toBe(200);
      const room = body.room as Record<string, unknown>;
      expect(room.name).toBe(renamed);
      // The public shape only — no identity or visibility columns.
      expect(room.owner_id).toBeUndefined();
      expect(room.visibility).toBeUndefined();

      const after = await readRoom(editRoom);
      expect(after.name).toBe(renamed);
      expect(after.owner_id).toBe(before.owner_id);
      expect(Date.parse(after.updated_at)).toBeGreaterThan(
        Date.parse(before.updated_at),
      );
    });

    it("accepts an identical repeat (repeated submissions are not errors)", async () => {
      const before = await readRoom(editRoom);
      await as(owner);

      const { response, body } = await patch(owner, editRoom, {
        name: before.name,
      });

      expect(response.status).toBe(200);
      expect((body.room as RoomRow).name).toBe(before.name);
    });

    it("answers 403 to a member who is not the owner and touches nothing", async () => {
      const before = await readRoom(editRoom);
      await as(member);

      const { response, body } = await patch(member, editRoom, {
        name: uniqueName("Hijacked"),
      });

      expect(response.status).toBe(403);
      expect(errorOf(body).code).toBe("not_owner");
      expect(await readRoom(editRoom)).toEqual(before);
    });

    it("answers the same 404 for a stranger and for a missing room", async () => {
      const before = await readRoom(editRoom);
      await as(stranger);

      const existing = await patch(stranger, editRoom, {
        name: uniqueName("Sneaky"),
      });
      const missing = await patch(stranger, MISSING_ROOM, {
        name: uniqueName("Sneaky"),
      });

      expect(existing.response.status).toBe(404);
      expect(missing.response.status).toBe(404);
      expect(errorOf(existing.body).code).toBe("not_found");
      expect(errorOf(missing.body).code).toBe("not_found");
      expect(await readRoom(editRoom)).toEqual(before);
    });

    it("rejects an anonymous patch with 401 before any lookup", async () => {
      clearCookies();

      const { response, body } = await patch(owner, editRoom, {
        name: uniqueName("Anon"),
      });

      expect(response.status).toBe(401);
      expect(errorOf(body).code).toBe("unauthenticated");
    });

    it("refuses identity and visibility fields at the schema layer", async () => {
      const before = await readRoom(editRoom);
      await as(owner);

      for (const forged of [
        { owner_id: stranger.id },
        { visibility: "private" },
        { id: MISSING_ROOM },
        { created_at: "2020-01-01T00:00:00.000Z" },
      ]) {
        const { response, body } = await patch(owner, editRoom, {
          name: before.name,
          ...forged,
        });
        expect(response.status).toBe(400);
        const error = errorOf(body);
        expect(error.code).toBe("validation");
        const key = Object.keys(forged)[0];
        expect(
          `${error.issues?.[0]?.path ?? ""} ${error.issues?.[0]?.message ?? ""}`,
        ).toContain(key);
      }
      expect(await readRoom(editRoom)).toEqual(before);
    });

    it("rejects an empty body with invalid_request", async () => {
      await as(owner);
      const { response, body } = await patch(owner, editRoom, {});

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("invalid_request");
    });
  });

  describe("PATCH: capacity floor", () => {
    it("raises freely and lowers to exactly the member count", async () => {
      await as(owner);

      const raised = await patch(owner, editRoom, { capacity: 10 });
      expect(raised.response.status).toBe(200);
      expect((raised.body.room as RoomRow).capacity).toBe(10);

      const exact = await patch(owner, editRoom, { capacity: 2 });
      expect(exact.response.status).toBe(200);
      expect((exact.body.room as RoomRow).capacity).toBe(2);
    });

    it("refuses to go below the member count and leaves capacity unchanged", async () => {
      const before = await readRoom(editRoom);
      expect(before.capacity).toBe(2);
      await as(owner);

      const { response, body } = await patch(owner, editRoom, { capacity: 1 });

      expect(response.status).toBe(409);
      const error = errorOf(body);
      expect(error.code).toBe("capacity_below_membership");
      expect(error.message).toContain("2");
      expect((await readRoom(editRoom)).capacity).toBe(2);
    });

    it("serializes with join_room so capacity can never end up below membership", async () => {
      // Seed the owner session first so both branches start together —
      // a slow sign-in inside the race would make it deterministic, not racing.
      await as(owner);

      type JoinOutcome = {
        joined: boolean;
        result?: { membership: string };
        error?: unknown;
      };

      const [patchOutcome, joinOutcome] = await Promise.all([
        patch(owner, raceRoom, { capacity: 1 }).then((r) => ({
          status: r.response.status,
        })),
        joinRoom(joiner.client, raceRoom)
          .then((result) => ({ joined: true, result } as JoinOutcome))
          .catch((error: unknown) => ({ joined: false, error } as JoinOutcome)),
      ]);

      // Exactly one of the two interleavings; both preserve the floor.
      if (patchOutcome.status === 200) {
        expect(joinOutcome.joined).toBe(false);
        expect(
          joinOutcome.error instanceof MembershipError &&
            joinOutcome.error.code === "room_full",
        ).toBe(true);
      } else {
        expect(patchOutcome.status).toBe(409);
        expect(joinOutcome.joined).toBe(true);
      }

      const room = await readRoom(raceRoom);
      const members = Number(
        psql(
          `select count(*) from public.room_members where room_id = '${raceRoom}';`,
        ),
      );
      expect(room.capacity).toBeGreaterThanOrEqual(members);
    });
  });

  describe("PATCH: open and close", () => {
    it("closing blocks new joins while existing members keep their seats", async () => {
      await as(owner);
      const { response, body } = await patch(owner, statusRoom, {
        status: "closed",
      });
      expect(response.status).toBe(200);
      expect((body.room as RoomRow).status).toBe("closed");

      await expect(joinRoom(joiner.client, statusRoom)).rejects.toThrow(
        MembershipError,
      );

      const seats = Number(
        psql(
          `select count(*) from public.room_members where room_id = '${statusRoom}';`,
        ),
      );
      expect(seats).toBe(2);
      expect(cascadeCounts(statusRoom).members).toBe(2);
    });

    it("reopening lets new members join again", async () => {
      await as(owner);
      const { response, body } = await patch(owner, statusRoom, {
        status: "open",
      });
      expect(response.status).toBe(200);
      expect((body.room as RoomRow).status).toBe("open");

      const joined = await joinRoom(joiner.client, statusRoom);
      expect(joined.membership).toBe("joined");
      expect(cascadeCounts(statusRoom).members).toBe(3);
    });

    it("still lists a closed room's members (edit permission is not membership)", async () => {
      await as(owner);
      await patch(owner, statusRoom, { status: "closed" });

      expect(cascadeCounts(statusRoom).members).toBe(3);
    });
  });

  describe("direct database writes stay impossible", () => {
    it("denies every direct UPDATE and DELETE on rooms for authenticated users", async () => {
      const updated = await owner.client
        .from("rooms")
        .update({ name: "Direct edit" })
        .eq("id", editRoom)
        .select("id");
      expect(updated.error?.code).toBe("42501");
      expect(updated.data).toBeNull();

      const deleted = await owner.client
        .from("rooms")
        .delete()
        .eq("id", editRoom)
        .select("id");
      expect(deleted.error?.code).toBe("42501");
      expect(deleted.data).toBeNull();

      expect((await readRoom(editRoom)).name).not.toBe("Direct edit");
    });

    it("denies the same writes to anon", async () => {
      const updated = await stranger.client
        .from("rooms")
        .update({ name: "Anon edit" })
        .eq("id", editRoom)
        .select("id");
      expect(updated.error?.code).toBe("42501");

      const deleted = await stranger.client
        .from("rooms")
        .delete()
        .eq("id", editRoom)
        .select("id");
      expect(deleted.error?.code).toBe("42501");
    });

    it("freezes the grant surface: no table grants, RPC execute only for authenticated", () => {
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.rooms', 'update');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.rooms', 'delete');",
        ),
      ).toBe("f");
      expect(
        psql("select has_table_privilege('anon', 'public.rooms', 'update');"),
      ).toBe("f");
      expect(
        psql("select has_table_privilege('anon', 'public.rooms', 'delete');"),
      ).toBe("f");

      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.update_room(uuid,jsonb)', 'execute');",
        ),
      ).toBe("t");
      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.delete_room(uuid)', 'execute');",
        ),
      ).toBe("t");
      expect(
        psql(
          "select has_function_privilege('anon', 'public.update_room(uuid,jsonb)', 'execute');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select has_function_privilege('anon', 'public.delete_room(uuid)', 'execute');",
        ),
      ).toBe("f");
    });

    it("keeps exactly the four storage policies, including the room-owner delete", () => {
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects';",
        ),
      ).toBe("4");
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'storage' " +
            "and policyname = 'study_resources_objects_delete_room_owner';",
        ),
      ).toBe("1");
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'storage' " +
            "and policyname = 'study_resources_objects_delete';",
        ),
      ).toBe("1");
    });

    it("control: widening the UPDATE grant in-transaction still exposes zero rows (RLS)", () => {
      const controlId = "44444444-4444-4444-8444-444444444444";
      const controlUser = "55555555-5555-4555-8555-555555555555";

      // Proves the *absence of the grant* is not the only thing standing
      // between an authenticated caller and the row: widen layer one and
      // layer two (RLS, no UPDATE policy) still filters the row out. Rolled
      // back in the same script, so nothing persists.
      const out = psql(
        [
          "begin;",
          "set local session_replication_role = replica;",
          `insert into public.rooms (id, owner_id, name, capacity) values ('${controlId}', '${controlUser}', 'Control Room', 4);`,
          "grant update on public.rooms to authenticated;",
          "set local role authenticated;",
          `set local request.jwt.claims to '{"sub":"${controlUser}","role":"authenticated"}';`,
          `update public.rooms set name = 'Widened' where id = '${controlId}';`,
          `select 'control:' || name from public.rooms where id = '${controlId}';`,
          "rollback;",
        ].join("\n"),
      );

      expect(out).toContain("UPDATE 0");
      expect(out).toContain("control:Control Room");
      expect(
        psql(`select count(*) from public.rooms where id = '${controlId}';`),
      ).toBe("0");
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.rooms', 'update');",
        ),
      ).toBe("f");
    });
  });

  describe("storage policy behavior around room-owned files", () => {
    it("lets the room owner remove a member's object, but no outsider", async () => {
      expect(storageObjectCount(policyRoom)).toBe(2);

      // Layer: the new room-owner policy — alice is not the uploader.
      const ownerRemoval = await owner.client.storage
        .from(RESOURCE_BUCKET)
        .remove([policyPathA]);
      expect(ownerRemoval.error).toBeNull();
      expect(storageObjectCount(policyRoom)).toBe(1);

      // The uploader-only policy still governs everyone else: the stranger
      // is not in the room, so their remove changes nothing.
      await stranger.client.storage.from(RESOURCE_BUCKET).remove([policyPathB]);
      expect(storageObjectCount(policyRoom)).toBe(1);

      // The uploader keeps the original right.
      const memberRemoval = await member.client.storage
        .from(RESOURCE_BUCKET)
        .remove([policyPathB]);
      expect(memberRemoval.error).toBeNull();
      expect(storageObjectCount(policyRoom)).toBe(0);
    });
  });

  describe("DELETE", () => {
    it("refuses a member, a stranger, and an anonymous caller while the room stays intact", async () => {
      const before = await readRoom(victimRoom);
      const countsBefore = cascadeCounts(victimRoom);

      await as(member);
      const byMember = await del(member, victimRoom);
      expect(byMember.response.status).toBe(403);
      expect(errorOf(byMember.body).code).toBe("not_owner");

      await as(stranger);
      const byStranger = await del(stranger, victimRoom);
      expect(byStranger.response.status).toBe(404);
      expect(errorOf(byStranger.body).code).toBe("not_found");

      clearCookies();
      const byAnon = await del(owner, victimRoom);
      expect(byAnon.response.status).toBe(401);

      expect(await readRoom(victimRoom)).toEqual(before);
      expect(cascadeCounts(victimRoom)).toEqual(countsBefore);
    });

    it("removes every dependent row and the member's uploaded object for the owner", async () => {
      const countsBefore = cascadeCounts(deleteRoom);
      expect(countsBefore).toEqual({
        members: 2,
        goals: 1,
        sessions: 1,
        messages: 1,
        // One accepted (the member's way in) + one still pending.
        invites: 2,
        resources: 1,
      });
      expect(storageObjectCount(deleteRoom)).toBe(1);
      expect(deleteResourcePath).toMatch(
        new RegExp(`^rooms/${deleteRoom}/${member.id}/`),
      );

      await as(owner);
      const { response, body } = await del(owner, deleteRoom);

      expect(response.status).toBe(200);
      expect(body).toEqual({ deleted: true });
      expect(cascadeCounts(deleteRoom)).toEqual({
        members: 0,
        goals: 0,
        sessions: 0,
        messages: 0,
        invites: 0,
        resources: 0,
      });
      expect(storageObjectCount(deleteRoom)).toBe(0);
      expect(
        psql(
          `select count(*) from public.rooms where id = '${deleteRoom}';`,
        ),
      ).toBe("0");
    });

    it("treats the repeat delete and a later patch as a missing room", async () => {
      await as(owner);

      const repeat = await del(owner, deleteRoom);
      expect(repeat.response.status).toBe(404);
      expect(errorOf(repeat.body).code).toBe("not_found");

      const patched = await patch(owner, deleteRoom, { name: "Ghost" });
      expect(patched.response.status).toBe(404);
      expect(errorOf(patched.body).code).toBe("not_found");
    });
  });
});
