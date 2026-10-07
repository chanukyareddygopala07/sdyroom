import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as invitePost, GET as inviteListGet } from "@/app/api/rooms/[id]/invitations/route";
import { DELETE as inviteRevokeDelete } from "@/app/api/rooms/[id]/invitations/[invitationId]/route";
import { GET as inboxGet } from "@/app/api/invitations/route";
import { POST as acceptPost } from "@/app/api/invitations/[id]/accept/route";
import { POST as rejectPost } from "@/app/api/invitations/[id]/reject/route";
import { GET as membersGet } from "@/app/api/rooms/[id]/members/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { psql } from "./helpers/admin";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

/**
 * Addressed invitations (007) end to end through the real route handlers:
 * alias-only creation, invitee-only accept/reject by id, owner revoke,
 * derived expiry, the roster, and the grant/policy freeze that keeps
 * `room_members` exactly as PR #3 left it. Every identity in the flows below
 * is a real signed-in auth user; SQL runs only for schema assertions and for
 * backdating a deadline, never to grant or bypass authorization.
 */
describe("private room invitations", () => {
  let owner: TestUser;
  let ivy: TestUser;
  let mike: TestUser;
  let sam: TestUser;
  let dan: TestUser;

  let ownerAlias: string;
  let ivyAlias: string;
  let mikeAlias: string;
  let samAlias: string;
  let danAlias: string;

  let privateRoom: string;
  let publicRoom: string;
  let tinyRoom: string;

  /** Assigned during creation, accepted later — crosses describe blocks. */
  let ivyInviteId: string;

  const MISSING_ROOM = "00000000-0000-4000-8000-000000000000";

  beforeAll(async () => {
    [owner, ivy, mike, sam, dan] = await Promise.all([
      createUser("inv-owner"),
      createUser("inv-ivy"),
      createUser("inv-mike"),
      createUser("inv-sam"),
      createUser("inv-dan"),
    ]);

    ownerAlias = uniqueAlias("own");
    ivyAlias = uniqueAlias("ivy");
    mikeAlias = uniqueAlias("mik");
    samAlias = uniqueAlias("sam");
    danAlias = uniqueAlias("dan");

    const profiles: [TestUser, string][] = [
      [owner, ownerAlias],
      [ivy, ivyAlias],
      [mike, mikeAlias],
      [sam, samAlias],
      [dan, danAlias],
    ];
    await Promise.all(
      profiles.map(([user, alias]) => createProfile(user.client, user.id, alias)),
    );

    privateRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({
          name: uniqueName("InviteOnly"),
          capacity: 4,
          visibility: "private",
        }),
      )
    ).id;
    publicRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("Open"), capacity: 4 }),
      )
    ).id;
    tinyRoom = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({
          name: uniqueName("LastSeat"),
          capacity: 2,
          visibility: "private",
        }),
      )
    ).id;
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([owner, ivy, mike, sam, dan]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function invite(roomId: string, body: unknown, pathOverride?: string) {
    const path = pathOverride ?? `/api/rooms/${roomId}/invitations`;
    return callApiWithParams(
      invitePost,
      { path, method: "POST", body },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function listInvites(roomId: string) {
    return callApiWithParams(
      inviteListGet,
      { path: `/api/rooms/${roomId}/invitations`, method: "GET" },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function revoke(roomId: string, invitationId: string) {
    return callApiWithParams(
      inviteRevokeDelete,
      {
        path: `/api/rooms/${roomId}/invitations/${invitationId}`,
        method: "DELETE",
      },
      { id: roomId, invitationId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function inbox() {
    return callApi(inboxGet, { path: "/api/invitations" }).then(
      async (response) => ({ response, body: await readJson(response) }),
    );
  }

  function accept(invitationId: string) {
    return callApiWithParams(
      acceptPost,
      {
        path: `/api/invitations/${invitationId}/accept`,
        method: "POST",
        body: {},
      },
      { id: invitationId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function reject(invitationId: string) {
    return callApiWithParams(
      rejectPost,
      {
        path: `/api/invitations/${invitationId}/reject`,
        method: "POST",
        body: {},
      },
      { id: invitationId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function roster(roomId: string) {
    return callApiWithParams(
      membersGet,
      { path: `/api/rooms/${roomId}/members`, method: "GET" },
      { id: roomId },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function invitationList(body: Record<string, unknown>): Record<string, unknown>[] {
    const invitations = body.invitations;
    if (!Array.isArray(invitations)) {
      throw new Error(`Expected invitations[], got ${JSON.stringify(body).slice(0, 200)}`);
    }
    return invitations as Record<string, unknown>[];
  }

  describe("request guards for creation", () => {
    it("rejects an anonymous create with 401", async () => {
      clearCookies();
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ivyAlias,
      });

      expect(response.status).toBe(401);
      expect(errorOf(body).code).toBe("unauthenticated");
    });

    it("rejects a room id that is not a UUID", async () => {
      await as(owner);
      const { response, body } = await invite("not-a-uuid", {
        invitee_alias: ivyAlias,
      });

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("validation");
    });

    it("refuses an email field instead of using it", async () => {
      await as(owner);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ivyAlias,
        email: owner.email,
      });

      expect(response.status).toBe(400);
      expect(errorOf(body).code).toBe("validation");
    });

    it("answers 404 to a non-member asking about a private room", async () => {
      await as(sam);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ivyAlias,
      });

      expect(response.status).toBe(404);
      expect(errorOf(body).code).toBe("not_found");
    });

    it("answers 409 room_public for a public room", async () => {
      await as(owner);
      const { response, body } = await invite(publicRoom, {
        invitee_alias: ivyAlias,
      });

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("room_public");
    });

    it("refuses a self-invitation", async () => {
      await as(owner);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ownerAlias,
      });

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("self_invite");
    });

    it("answers 404 invitee_not_found for an alias nobody studies under", async () => {
      await as(owner);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: `ghost${Date.now()}`,
      });

      expect(response.status).toBe(404);
      expect(errorOf(body).code).toBe("invitee_not_found");
    });
  });

  describe("creating and seeing an invitation", () => {
    it("creates an addressed invitation and answers 201 without any user id", async () => {
      await as(owner);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ivyAlias,
        ttl_hours: 24,
      });

      expect(response.status).toBe(201);
      const invitation = body.invitation as Record<string, unknown>;
      expect(invitation).toMatchObject({
        room_id: privateRoom,
        inviter_alias: ownerAlias,
        invitee_alias: ivyAlias,
        status: "pending",
        expired: false,
      });
      ivyInviteId = String(invitation.id);

      // Nothing addressable is a user id or an email: aliases are the whole
      // addressing scheme of this feature.
      const json = JSON.stringify(body);
      expect(json).not.toContain(owner.id);
      expect(json).not.toContain(ivy.id);
      expect(json).not.toContain(owner.email);
      expect(json).not.toContain(ivy.email);
    });

    it("refuses a second pending invitation for the same student", async () => {
      await as(owner);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ivyAlias,
      });

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("already_invited");
    });

    it("shows the invitation to the invitee, and to neither bystander", async () => {
      await as(ivy);
      const mine = await inbox();
      expect(mine.response.status).toBe(200);
      const rows = invitationList(mine.body);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: ivyInviteId,
        room_id: privateRoom,
        inviter_alias: ownerAlias,
        invitee_alias: ivyAlias,
        status: "pending",
        expired: false,
      });
      expect(JSON.stringify(mine.body)).not.toContain(owner.id);
      expect(JSON.stringify(mine.body)).not.toContain(ivy.id);

      await as(sam);
      const stranger = await inbox();
      expect(invitationList(stranger.body)).toHaveLength(0);

      // The owner created it, but the inbox is the *invitee's* view: an
      // inviter's outgoing rows must not appear there.
      await as(owner);
      const outgoing = await inbox();
      expect(invitationList(outgoing.body)).toHaveLength(0);
    });

    it("exposes the row through RLS only to its two parties", async () => {
      const { data: inviteeRows, error: inviteeError } = await ivy.client
        .from("room_invitations")
        .select("id, status")
        .eq("id", ivyInviteId);
      expect(inviteeError).toBeNull();
      expect(inviteeRows).toHaveLength(1);

      const { data: ownerRows, error: ownerError } = await owner.client
        .from("room_invitations")
        .select("id, status")
        .eq("room_id", privateRoom);
      expect(ownerError).toBeNull();
      expect((ownerRows ?? []).map((row) => row.id)).toContain(ivyInviteId);

      const { data: strangerRows, error: strangerError } = await sam.client
        .from("room_invitations")
        .select("id")
        .eq("id", ivyInviteId);
      expect(strangerError).toBeNull();
      expect(strangerRows).toHaveLength(0);
    });

    it("grants the application role read-only access to the table", () => {
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.room_invitations', 'select');",
        ),
      ).toBe("t");
      for (const privilege of ["insert", "update", "delete"]) {
        expect(
          psql(
            `select has_table_privilege('authenticated', 'public.room_invitations', '${privilege}');`,
          ),
        ).toBe("f");
      }
      expect(
        psql("select has_table_privilege('anon', 'public.room_invitations', 'select');"),
      ).toBe("f");
    });

    it("refuses a direct PostgREST write by the owner", async () => {
      const { error } = await owner.client.from("room_invitations").insert({
        room_id: privateRoom,
        inviter_id: owner.id,
        invitee_id: sam.id,
        room_name: "forged",
        inviter_alias: ownerAlias,
        invitee_alias: samAlias,
        status: "pending",
      });
      expect(error).not.toBeNull();
    });
  });

  describe("accepting", () => {
    it("answers 404 to a student who does not hold the invitation", async () => {
      await as(sam);
      const accepted = await accept("33333333-3333-4333-8333-333333333333");
      expect(accepted.response.status).toBe(404);
      expect(errorOf(accepted.body).code).toBe("not_found");
    });

    it("hides the private room from discovery until the seat exists", async () => {
      // Before membership: the rooms policy shows public rooms and rooms you
      // belong to — this one is neither for everyone except the owner.
      const { data: forStranger } = await mike.client
        .from("rooms")
        .select("id")
        .eq("id", privateRoom)
        .maybeSingle();
      expect(forStranger).toBeNull();
    });

    it("grants a seat on accept and answers 201 with the room", async () => {
      await as(ivy);
      const { response, body } = await accept(ivyInviteId);

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        membership: "joined",
        room_id: privateRoom,
        member_count: 2,
      });

      const { data: membership } = await ivy.client
        .from("room_members")
        .select("room_id, role")
        .eq("room_id", privateRoom);
      expect(membership).toEqual([
        { room_id: privateRoom, role: "student" },
      ]);

      const { data: nowVisible } = await mike.client
        .from("rooms")
        .select("id")
        .eq("id", privateRoom)
        .maybeSingle();
      expect(nowVisible).toBeNull();
    });

    it("returns the roster to members without any identifiers", async () => {
      await as(ivy);
      const { response, body } = await roster(privateRoom);

      expect(response.status).toBe(200);
      expect(body.count).toBe(2);
      const members = body.members as Record<string, unknown>[];
      expect(members).toHaveLength(2);
      expect(members.map((row) => row.alias).sort()).toEqual(
        [ivyAlias, ownerAlias].sort(),
      );
      expect(members.find((row) => row.alias === ownerAlias)?.role).toBe("owner");
      expect(members.find((row) => row.alias === ivyAlias)?.role).toBe("student");
      for (const row of members) {
        expect(Object.keys(row).sort()).toEqual(["alias", "joined_at", "role"]);
      }
    });

    it("answers the same 404 for a non-member and for a missing room", async () => {
      await as(sam);
      const nonMember = await roster(privateRoom);
      expect(nonMember.response.status).toBe(404);
      expect(errorOf(nonMember.body).code).toBe("not_found");

      const missing = await roster(MISSING_ROOM);
      expect(missing.response.status).toBe(404);
      expect(errorOf(missing.body).code).toBe("not_found");
      expect(JSON.stringify(missing.body)).toBe(
        JSON.stringify(nonMember.body),
      );
    });

    it("rejects an anonymous roster read with 401", async () => {
      clearCookies();
      const { response } = await roster(privateRoom);
      expect(response.status).toBe(401);
    });

    it("answers 409 used when the same invitation is accepted twice", async () => {
      const { data: rows } = await ivy.client
        .from("room_invitations")
        .select("id, status")
        .eq("invitee_id", ivy.id);
      const resolved = (rows ?? []).find((row) => row.status === "accepted");
      expect(resolved).toBeTruthy();

      await as(ivy);
      const { response, body } = await accept(String(resolved?.id));

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("used");

      const { data: memberships } = await ivy.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", privateRoom);
      expect(memberships).toHaveLength(1);
    });

    it("shows the accepted invitation in the owner's room list", async () => {
      await as(owner);
      const { response, body } = await listInvites(privateRoom);

      expect(response.status).toBe(200);
      const accepted = invitationList(body).find(
        (row) => row.invitee_alias === ivyAlias,
      );
      expect(accepted).toMatchObject({ status: "accepted" });
      expect(accepted?.resolved_at).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(ivy.id);
      expect(JSON.stringify(body)).not.toContain(owner.id);
    });

    it("refuses to invite a student who already has a seat", async () => {
      await as(owner);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: ivyAlias,
      });

      expect(response.status).toBe(409);
      expect(errorOf(body).code).toBe("already_member");
    });

    it("answers 403 when a plain member tries to invite", async () => {
      await as(ivy);
      const { response, body } = await invite(privateRoom, {
        invitee_alias: mikeAlias,
      });

      expect(response.status).toBe(403);
      expect(errorOf(body).code).toBe("not_owner");
    });
  });

  describe("rejecting", () => {
    let mikeInviteId: string;

    it("records a rejection without granting a seat", async () => {
      await as(owner);
      const created = await invite(privateRoom, { invitee_alias: mikeAlias });
      expect(created.response.status).toBe(201);
      mikeInviteId = String(
        (created.body.invitation as Record<string, unknown>).id,
      );

      // A bystander cannot consume an invitation addressed to someone else.
      await as(sam);
      const wrongPerson = await accept(mikeInviteId);
      expect(wrongPerson.response.status).toBe(404);

      await as(mike);
      const { response, body } = await reject(mikeInviteId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ rejected: true });

      const { data: memberships } = await mike.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", privateRoom);
      expect(memberships).toHaveLength(0);
    });

    it("keeps the rejected status sticky: no re-reject and no accept", async () => {
      await as(mike);
      const again = await reject(mikeInviteId);
      expect(again.response.status).toBe(409);
      expect(errorOf(again.body).code).toBe("rejected");

      const accepted = await accept(mikeInviteId);
      expect(accepted.response.status).toBe(409);
      expect(errorOf(accepted.body).code).toBe("rejected");

      await as(owner);
      const { body } = await listInvites(privateRoom);
      const row = invitationList(body).find((r) => r.invitee_alias === mikeAlias);
      expect(row).toMatchObject({ status: "rejected" });
    });

    it("leaves the roster exactly as it was", async () => {
      await as(ivy);
      const { response, body } = await roster(privateRoom);
      expect(response.status).toBe(200);
      expect(body.count).toBe(2);
    });
  });

  describe("revoking", () => {
    let samInviteId: string;

    it("lets the owner revoke a pending invitation", async () => {
      await as(owner);
      const created = await invite(privateRoom, { invitee_alias: samAlias });
      expect(created.response.status).toBe(201);
      samInviteId = String(
        (created.body.invitation as Record<string, unknown>).id,
      );

      const { response, body } = await revoke(privateRoom, samInviteId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ revoked: true });
    });

    it("refuses revocation by a member who is not the owner", async () => {
      await as(owner);
      const created = await invite(privateRoom, { invitee_alias: danAlias });
      const pendingId = String(
        (created.body.invitation as Record<string, unknown>).id,
      );

      await as(ivy);
      const { response, body } = await revoke(privateRoom, pendingId);
      expect(response.status).toBe(403);
      expect(errorOf(body).code).toBe("not_owner");

      await as(owner);
      const stillPending = await revoke(privateRoom, pendingId);
      expect(stillPending.response.status).toBe(200);
    });

    it("answers 404 to a non-member and for an already-resolved row", async () => {
      await as(sam);
      const nonMember = await revoke(privateRoom, samInviteId);
      expect(nonMember.response.status).toBe(404);

      await as(owner);
      const resolved = await revoke(privateRoom, samInviteId);
      expect(resolved.response.status).toBe(404);
      expect(errorOf(resolved.body).code).toBe("not_found");
    });

    it("makes a revoked invitation refuse to join, while staying visible to the invitee", async () => {
      await as(sam);
      const accepted = await accept(samInviteId);
      expect(accepted.response.status).toBe(409);
      expect(errorOf(accepted.body).code).toBe("revoked");

      const mine = await inbox();
      const row = invitationList(mine.body).find((r) => r.id === samInviteId);
      expect(row).toMatchObject({ status: "revoked" });
    });
  });

  describe("expiry is read-time, not a job", () => {
    let danInviteId: string;

    it("expires a pending invitation once its deadline passes", async () => {
      await as(owner);
      const created = await invite(privateRoom, {
        invitee_alias: danAlias,
        ttl_hours: 168,
      });
      expect(created.response.status).toBe(201);
      danInviteId = String(
        (created.body.invitation as Record<string, unknown>).id,
      );

      // Fixture surgery only: the deadline itself is evaluated by the
      // database at read time, so moving it into the past proves 410 without
      // waiting a week. `created_at` travels too, because the table's own
      // check constraint forbids an invitation that expires before it was
      // ever created.
      psql(
        `update public.room_invitations ` +
          `set created_at = now() - interval '2 days', ` +
          `expires_at = now() - interval '1 hour' where id = '${danInviteId}';`,
      );

      await as(dan);
      const mine = await inbox();
      const row = invitationList(mine.body).find((r) => r.id === danInviteId);
      expect(row).toMatchObject({ status: "pending", expired: true });

      const accepted = await accept(danInviteId);
      expect(accepted.response.status).toBe(410);
      expect(errorOf(accepted.body).code).toBe("expired");

      const rejected = await reject(danInviteId);
      expect(rejected.response.status).toBe(410);
      expect(errorOf(rejected.body).code).toBe("expired");

      const { data: memberships } = await dan.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", privateRoom);
      expect(memberships).toHaveLength(0);
    });

    it("still lets the owner tidy an expired pending row", async () => {
      await as(owner);
      const { response, body } = await revoke(privateRoom, danInviteId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ revoked: true });
    });
  });

  describe("the last seat", () => {
    it("gives the seat to exactly one of two waiting students", async () => {
      await as(owner);
      const first = await invite(tinyRoom, { invitee_alias: ivyAlias });
      const second = await invite(tinyRoom, { invitee_alias: mikeAlias });
      expect(first.response.status).toBe(201);
      expect(second.response.status).toBe(201);
      const firstId = String(
        (first.body.invitation as Record<string, unknown>).id,
      );
      const secondId = String(
        (second.body.invitation as Record<string, unknown>).id,
      );

      // Owner holds seat 1 of 2; the first accept takes the last seat, and
      // the second must lose cleanly with its invitation left pending for a
      // seat that may free up later.
      await as(ivy);
      const winner = await accept(firstId);
      expect(winner.response.status).toBe(201);

      await as(mike);
      const loser = await accept(secondId);
      expect(loser.response.status).toBe(409);
      expect(errorOf(loser.body).code).toBe("room_full");

      await as(owner);
      const { body } = await listInvites(tinyRoom);
      const loserRow = invitationList(body).find(
        (row) => row.invitee_alias === mikeAlias,
      );
      expect(loserRow).toMatchObject({ status: "pending", expired: false });

      // `room_members_select_own` shows each student only their own row, so
      // the two sides assert their own seat (or its absence), and the total
      // is a read-only fixture observation.
      const { data: winnerSeat } = await ivy.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", tinyRoom);
      expect(winnerSeat).toHaveLength(1);
      const { data: loserSeat } = await mike.client
        .from("room_members")
        .select("room_id")
        .eq("room_id", tinyRoom);
      expect(loserSeat).toHaveLength(0);
      expect(
        Number(
          psql(
            `select count(*) from public.room_members where room_id = '${tinyRoom}';`,
          ),
        ),
      ).toBe(2);
    });
  });

  describe("the freeze: room_members is exactly as PR #3 left it", () => {
    it("keeps the same two policies and no others", () => {
      const policies = psql(
        "select string_agg(policyname, ',' order by policyname) " +
          "from pg_policies where schemaname = 'public' and tablename = 'room_members';",
      );
      expect(policies).toBe("room_members_insert_owner_self,room_members_select_own");
    });

    it("keeps the same grants: select and insert only", () => {
      for (const [privilege, expected] of [
        ["select", "t"],
        ["insert", "t"],
        ["update", "f"],
        ["delete", "f"],
      ] as const) {
        expect(
          psql(
            `select has_table_privilege('authenticated', 'public.room_members', '${privilege}');`,
          ),
        ).toBe(expected);
      }
    });

    it("keeps invitations at exactly one addressed-read policy", () => {
      const policies = psql(
        "select string_agg(policyname, ',' order by policyname) " +
          "from pg_policies where schemaname = 'public' and tablename = 'room_invitations';",
      );
      expect(policies).toBe("room_invitations_select_addressed");
    });

    it("keeps the seat implementation unreachable from clients", () => {
      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.join_room_core(uuid,uuid,bool)', 'execute');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select has_function_privilege('anon', 'public.join_room_core(uuid,uuid,bool)', 'execute');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.join_room(uuid)', 'execute');",
        ),
      ).toBe("t");
      expect(
        psql(
          "select has_function_privilege('anon', 'public.room_roster(uuid)', 'execute');",
        ),
      ).toBe("f");
    });
  });
});
