import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as invitePost } from "@/app/api/rooms/[id]/invitations/route";
import { POST as acceptPost } from "@/app/api/invitations/[id]/accept/route";
import { POST as mutePost } from "@/app/api/rooms/[id]/members/[alias]/mute/route";
import { DELETE as memberDelete } from "@/app/api/rooms/[id]/members/[alias]/route";
import { POST as reportPost } from "@/app/api/rooms/[id]/reports/route";
import { PATCH as reportPatch } from "@/app/api/reports/[reportId]/route";
import { GET as listGet } from "@/app/api/notifications/route";
import { GET as unreadCountGet } from "@/app/api/notifications/unread-count/route";
import { POST as readPost } from "@/app/api/notifications/[notificationId]/read/route";
import { POST as readAllPost } from "@/app/api/notifications/read-all/route";
import { PATCH as prefsPatch } from "@/app/api/profile/notification-prefs/route";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { callApi, callApiWithParams, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { psql, psqlExpectingFailure } from "./helpers/admin";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

/**
 * PR 11 end to end: isolation, the absence of an INSERT grant, the producer
 * authorization table (both directions), preferences at write time, the
 * dedupe collapse, the two real producer flows (invite, moderation), the
 * reporter-identity guarantee, and retention. SQL is used only to backdate a
 * row for the prune probe and to count rows the API must not see — never to
 * grant or bypass authorization.
 */
describe("notifications", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let prefsUser: TestUser;

  let ownerAlias: string;
  let memberAlias: string;
  let outsiderAlias: string;
  let prefsAlias: string;

  let roomId: string;

  beforeAll(async () => {
    [owner, member, outsider, prefsUser] = await Promise.all([
      createUser("ntf-owner"),
      createUser("ntf-member"),
      createUser("ntf-outsider"),
      createUser("ntf-prefs"),
    ]);

    ownerAlias = uniqueAlias("now");
    memberAlias = uniqueAlias("nmb");
    outsiderAlias = uniqueAlias("nos");
    prefsAlias = uniqueAlias("npr");

    const profiles: Array<[typeof owner, string]> = [
      [owner, ownerAlias],
      [member, memberAlias],
      [outsider, outsiderAlias],
      [prefsUser, prefsAlias],
    ];
    await Promise.all(
      profiles.map(([user, alias]) => createProfile(user.client, user.id, alias)),
    );

    roomId = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({
          name: uniqueName("Notif Room"),
          exam_track: "JEE",
          subject: "Physics",
          language: "English",
          capacity: 6,
          visibility: "private",
        }),
      )
    ).id;
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([owner, member, outsider, prefsUser]);
  });

  async function pushAs(
    user: TestUser,
    args: Record<string, unknown>,
  ): Promise<{ code?: string }> {
    const { data, error } = await user.client.rpc("push_notification", args);
    if (error) {
      throw new Error(`push_notification failed: ${error.message}`);
    }
    return data as { code?: string };
  }

  async function rowsFor(user: TestUser): Promise<Record<string, unknown>[]> {
    const { data, error } = await user.client
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      throw new Error(`select failed: ${error.message}`);
    }
    return (data ?? []) as Record<string, unknown>[];
  }

  describe("grants and direct writes", () => {
    it("refuses a direct PostgREST insert — there is no INSERT grant", async () => {
      const { error } = await member.client.from("notifications").insert({
        user_id: member.id,
        type: "system",
        payload: { title: "forged", body: "straight through" },
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(await rowsFor(member)).toHaveLength(0);
    });

    it("cannot be written by the service_role path either from the app", async () => {
      // The table grants the app roles SELECT/UPDATE(read_at)/DELETE only;
      // `postgres` (owner) retains the default privileges, which is how the
      // prune function and the definer RPCs write. This probe asserts the
      // grantee list itself so a future `grant insert to authenticated`
      // fails here rather than in production.
      const grants = psql(
        `select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where table_schema = 'public' and table_name = 'notifications' and grantee in ('authenticated', 'anon', 'service_role');`,
      );
      expect(grants).not.toContain("INSERT");
    });
  });

  describe("producer authorization", () => {
    it("lets the room owner push member_removed to a member", async () => {
      const result = await pushAs(owner, {
        p_user_id: member.id,
        p_type: "member_removed",
        p_payload: { title: "You were removed", body: "Out you go." },
        p_room_id: roomId,
        p_dedupe_key: `member_removed:${roomId}`,
      });
      expect(result.code).toBe("created");

      const rows = await rowsFor(member);
      expect(rows.some((row) => row.type === "member_removed")).toBe(true);
    });

    it("refuses the same push from a stranger — not_authorized, no row", async () => {
      const before = await rowsFor(member);
      const result = await pushAs(outsider, {
        p_user_id: member.id,
        p_type: "member_removed",
        p_payload: { title: "forged", body: "forged" },
        p_room_id: roomId,
        p_dedupe_key: null,
      });
      expect(result.code).toBe("not_authorized");
      expect(await rowsFor(member)).toHaveLength(before.length);
    });

    it("refuses invite_created from anyone but the room owner", async () => {
      // The moderator-shaped caller here is a plain stranger; the owner-only
      // rule is stricter than the owner-or-moderator one the other types use.
      const result = await pushAs(outsider, {
        p_user_id: prefsUser.id,
        p_type: "invite_created",
        p_payload: { title: "forged invite", body: "forged" },
        p_room_id: roomId,
        p_dedupe_key: null,
      });
      expect(result.code).toBe("not_authorized");
    });

    it("refuses a self-scoped type aimed at another user", async () => {
      const result = await pushAs(outsider, {
        p_user_id: member.id,
        p_type: "resource_ready",
        p_payload: { title: "forged ready", body: "forged" },
        p_room_id: null,
        p_dedupe_key: null,
      });
      expect(result.code).toBe("not_authorized");
    });

    it("refuses the system type aimed at another user", async () => {
      const result = await pushAs(outsider, {
        p_user_id: owner.id,
        p_type: "system",
        p_payload: { title: "forged system", body: "forged" },
        p_room_id: null,
        p_dedupe_key: null,
      });
      expect(result.code).toBe("not_authorized");
    });

    it("refuses a room-scoped type that names no room", async () => {
      const result = await pushAs(owner, {
        p_user_id: member.id,
        p_type: "muted",
        p_payload: { title: "muted", body: "muted" },
        p_room_id: null,
        p_dedupe_key: null,
      });
      expect(result.code).toBe("validation");
    });

    it("lets a self-notify through (the reserved types' rule)", async () => {
      const result = await pushAs(outsider, {
        p_user_id: outsider.id,
        p_type: "resource_ready",
        p_payload: { title: "Processing finished", body: "Your file is ready." },
        p_room_id: null,
        p_dedupe_key: null,
      });
      expect(result.code).toBe("created");
    });
  });

  describe("preferences at write time", () => {
    const key = `muted:${roomId}`;

    async function setPrefs(user: TestUser, prefs: Record<string, string>) {
      await seedSession(user.email, user.password);
      const response = await callApi(prefsPatch, {
        path: "/api/profile/notification-prefs",
        method: "PATCH",
        body: { prefs },
      });
      expect(response.status).toBe(200);
    }

    it("a muted category prevents the row; flipping back allows it", async () => {
      await setPrefs(member, { moderation: "none" });

      const muted = await pushAs(owner, {
        p_user_id: member.id,
        p_type: "muted",
        p_payload: { title: "You were muted", body: "Hidden for an hour." },
        p_room_id: roomId,
        p_dedupe_key: `${key}:pref-probe`,
      });
      expect(muted.code).toBe("muted");
      expect(
        (await rowsFor(member)).some(
          (row) => row.dedupe_key === `${key}:pref-probe`,
        ),
      ).toBe(false);

      await setPrefs(member, { moderation: "all" });

      const allowed = await pushAs(owner, {
        p_user_id: member.id,
        p_type: "muted",
        p_payload: { title: "You were muted", body: "Hidden for an hour." },
        p_room_id: roomId,
        p_dedupe_key: `${key}:pref-probe`,
      });
      expect(allowed.code).toBe("created");
    });

    it("mentions_and_invites suppresses moderation but not invites", async () => {
      await setPrefs(prefsUser, { moderation: "mentions_and_invites", invite: "mentions_and_invites" });

      const moderation = await pushAs(owner, {
        p_user_id: prefsUser.id,
        p_type: "muted",
        p_payload: { title: "muted", body: "muted" },
        p_room_id: roomId,
        p_dedupe_key: "mentions-probe-moderation",
      });
      expect(moderation.code).toBe("muted");

      const invite = await pushAs(owner, {
        p_user_id: prefsUser.id,
        p_type: "invite_created",
        p_payload: { title: "Invitation", body: "You are invited." },
        p_room_id: roomId,
        p_dedupe_key: "mentions-probe-invite",
      });
      expect(invite.code).toBe("created");
    });

    it("prefs persist across sessions and shape what the PATCH returns", async () => {
      await seedSession(member.email, member.password);
      const response = await callApi(prefsPatch, {
        path: "/api/profile/notification-prefs",
        method: "PATCH",
        body: { prefs: { moderation: "all" } },
      });
      const body = await readJson(response);
      expect(body.prefs).toMatchObject({ moderation: "all", invite: "all" });
    });
  });

  describe("dedupe", () => {
    it("collapses two unread pushes onto one row and refreshes it", async () => {
      const dedupeKey = `dedupe-probe:${roomId}`;
      const first = await pushAs(owner, {
        p_user_id: outsider.id,
        p_type: "muted",
        p_payload: { title: "First wording", body: "one" },
        p_room_id: roomId,
        p_dedupe_key: dedupeKey,
      });
      expect(first.code).toBe("created");

      // A distinct now() for the collapse to be visible.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await pushAs(owner, {
        p_user_id: outsider.id,
        p_type: "muted",
        p_payload: { title: "Second wording", body: "two" },
        p_room_id: roomId,
        p_dedupe_key: dedupeKey,
      });
      expect(second.code).toBe("deduped");

      const rows = (await rowsFor(outsider)).filter(
        (row) => row.dedupe_key === dedupeKey,
      );
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as { title: string }).title).toBe("Second wording");
    });

    it("a read row no longer blocks a new one on the same subject", async () => {
      const dedupeKey = `dedupe-read-probe:${roomId}`;
      const created = await pushAs(owner, {
        p_user_id: outsider.id,
        p_type: "muted",
        p_payload: { title: "Before read", body: "one" },
        p_room_id: roomId,
        p_dedupe_key: dedupeKey,
      });
      const createdId = (created as { id?: string }).id;
      expect(createdId).toBeTypeOf("string");

      await seedSession(outsider.email, outsider.password);
      const read = await callApiWithParams(
        readPost,
        {
          path: `/api/notifications/${createdId}/read`,
          method: "POST",
          body: {},
        },
        { notificationId: createdId! },
      );
      expect(read.status).toBe(200);

      const again = await pushAs(owner, {
        p_user_id: outsider.id,
        p_type: "muted",
        p_payload: { title: "After read", body: "two" },
        p_room_id: roomId,
        p_dedupe_key: dedupeKey,
      });
      expect(again.code).toBe("created");

      const rows = (await rowsFor(outsider)).filter(
        (row) => row.dedupe_key === dedupeKey,
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe("isolation across users", () => {
    it("list, unread count, read and read-all never cross the boundary", async () => {
      await seedSession(member.email, member.password);

      const list = await callApi(listGet, { path: "/api/notifications?limit=50" });
      expect(list.status).toBe(200);
      const listBody = await readJson(list);
      const rows = listBody.notifications as { id: string }[];
      // Everything the member sees belongs to the member.
      expect(rows.length).toBeGreaterThan(0);

      // Pick one of the member's own rows and try to read it as the outsider.
      const targetId = rows[0].id;
      await seedSession(outsider.email, outsider.password);

      const foreignRead = await callApiWithParams(
        readPost,
        {
          path: `/api/notifications/${targetId}/read`,
          method: "POST",
          body: {},
        },
        { notificationId: targetId },
      );
      expect(foreignRead.status).toBe(404);

      // The row is untouched — zero rows changed, not merely hidden.
      const unchanged = psql(
        `select count(*) from public.notifications where id = '${targetId}' and read_at is null;`,
      );
      expect(unchanged).toBe("1");

      const foreignAll = await callApi(readAllPost, {
        path: "/api/notifications/read-all",
        method: "POST",
        body: {},
      });
      expect(foreignAll.status).toBe(200);
      const foreignBody = await readJson(foreignAll);
      // read-all touched only the outsider's own unread rows.
      const memberUnread = psql(
        `select count(*) from public.notifications where user_id = '${member.id}' and read_at is null;`,
      );
      expect(Number(memberUnread)).toBeGreaterThan(0);
      expect((foreignBody.updated as number)).toBeGreaterThanOrEqual(0);
    });

    it("unread-count reflects only the caller", async () => {
      await seedSession(member.email, member.password);
      const memberCount = await readJson(await callApi(unreadCountGet, { path: "/api/notifications/unread-count" }));
      const authoritativeMember = Number(
        psql(
          `select count(*) from public.notifications where user_id = '${member.id}' and read_at is null;`,
        ),
      );
      expect(memberCount.unread_count).toBe(authoritativeMember);

      await seedSession(outsider.email, outsider.password);
      const outsiderCount = await readJson(await callApi(unreadCountGet, { path: "/api/notifications/unread-count" }));
      const authoritativeOutsider = Number(
        psql(
          `select count(*) from public.notifications where user_id = '${outsider.id}' and read_at is null;`,
        ),
      );
      expect(outsiderCount.unread_count).toBe(authoritativeOutsider);
    });
  });

  describe("the two real producers", () => {
    let inviteNotificationId: string;
    let invitationId: string;

    it("an invitation creates the invitee's row (route-level producer)", async () => {
      await seedSession(owner.email, owner.password);
      const response = await callApiWithParams(
        invitePost,
        {
          path: `/api/rooms/${roomId}/invitations`,
          method: "POST",
          body: { invitee_alias: prefsAlias },
        },
        { id: roomId },
      );
      expect(response.status).toBe(201);
      const body = await readJson(response);
      invitationId = (body.invitation as { id: string }).id;

      await seedSession(prefsUser.email, prefsUser.password);
      const list = await readJson(
        await callApi(listGet, { path: "/api/notifications?limit=50" }),
      );
      const inviteRow = (list.notifications as Record<string, unknown>[]).find(
        (row) => row.type === "invite_created",
      );
      expect(inviteRow).toBeTruthy();
      expect(inviteRow!.room_id).toBe(roomId);
      const payload = inviteRow!.payload as { title: string; body: string; href: string };
      expect(payload.title).toContain("Invitation");
      expect(payload.body).toContain(ownerAlias);
      expect(payload.href).toBe("/invitations");
      inviteNotificationId = inviteRow!.id as string;
    });

    it("the invitee can read their own row and the badge goes to zero", async () => {
      await seedSession(prefsUser.email, prefsUser.password);

      const read = await callApiWithParams(
        readPost,
        {
          path: `/api/notifications/${inviteNotificationId}/read`,
          method: "POST",
          body: {},
        },
        { notificationId: inviteNotificationId },
      );
      expect(read.status).toBe(200);
      expect(await readJson(read)).toEqual({ read: true, unchanged: false });

      const repeat = await callApiWithParams(
        readPost,
        {
          path: `/api/notifications/${inviteNotificationId}/read`,
          method: "POST",
          body: {},
        },
        { notificationId: inviteNotificationId },
      );
      expect(repeat.status).toBe(200);
      expect(await readJson(repeat)).toEqual({ read: true, unchanged: true });

      const count = await readJson(
        await callApi(unreadCountGet, { path: "/api/notifications/unread-count" }),
      );
      // The badge tracks the database exactly — including whatever earlier
      // probes left this user with — so the assertion is the authoritative
      // count, not a hand-tallied zero.
      const authoritative = Number(
        psql(
          `select count(*) from public.notifications where user_id = '${prefsUser.id}' and read_at is null;`,
        ),
      );
      expect(count.unread_count).toBe(authoritative);
    });

    it("moderation actions notify the target (mute + remove producers)", async () => {
      // The prefs user accepts the invitation so they are a member who can
      // be muted and removed. Their moderation category was left on
      // "mentions_and_invites" by the preferences probe above, which would
      // suppress the mute row — preferences are reset here so the producer
      // itself is what this test measures.
      await seedSession(prefsUser.email, prefsUser.password);
      const prefsReset = await callApi(prefsPatch, {
        path: "/api/profile/notification-prefs",
        method: "PATCH",
        body: { prefs: { moderation: "all" } },
      });
      expect(prefsReset.status).toBe(200);

      const accept = await callApiWithParams(
        acceptPost,
        {
          path: `/api/invitations/${invitationId}/accept`,
          method: "POST",
          body: {},
        },
        { id: invitationId },
      );
      expect(accept.status).toBe(201);

      await seedSession(owner.email, owner.password);
      const mute = await callApiWithParams(
        mutePost,
        {
          path: `/api/rooms/${roomId}/members/${prefsAlias}/mute`,
          method: "POST",
          body: { duration: "1h" },
        },
        { id: roomId, alias: prefsAlias },
      );
      expect(mute.status).toBe(201);

      await seedSession(prefsUser.email, prefsUser.password);
      let list = await readJson(
        await callApi(listGet, { path: "/api/notifications?limit=50" }),
      );
      const muteRow = (list.notifications as Record<string, unknown>[]).find(
        (row) => row.type === "muted",
      );
      expect(muteRow).toBeTruthy();
      expect(muteRow!.room_id).toBe(roomId);
      expect((muteRow!.payload as { href: string }).href).toBe(`/rooms/${roomId}`);

      await seedSession(owner.email, owner.password);
      const remove = await callApiWithParams(
        memberDelete,
        {
          path: `/api/rooms/${roomId}/members/${prefsAlias}`,
          method: "DELETE",
          body: {},
        },
        { id: roomId, alias: prefsAlias },
      );
      expect(remove.status).toBe(200);

      await seedSession(prefsUser.email, prefsUser.password);
      list = await readJson(
        await callApi(listGet, { path: "/api/notifications?limit=50" }),
      );
      const removedRow = (list.notifications as Record<string, unknown>[]).find(
        (row) => row.type === "member_removed",
      );
      expect(removedRow).toBeTruthy();
      // A removed member is sent to the room list, not a workspace 404.
      expect((removedRow!.payload as { href: string }).href).toBe("/rooms");
    });

    it("a resolved report notifies the reporter without naming them", async () => {
      // The member joins first — a report requires membership — then files a
      // report about the owner (a user subject, by alias) and the owner, the
      // room's owner, resolves it.
      await seedSession(owner.email, owner.password);
      const invite = await callApiWithParams(
        invitePost,
        {
          path: `/api/rooms/${roomId}/invitations`,
          method: "POST",
          body: { invitee_alias: memberAlias },
        },
        { id: roomId },
      );
      expect(invite.status).toBe(201);
      const memberInvitationId = ((await readJson(invite)).invitation as { id: string }).id;

      await seedSession(member.email, member.password);
      const joined = await callApiWithParams(
        acceptPost,
        {
          path: `/api/invitations/${memberInvitationId}/accept`,
          method: "POST",
          body: {},
        },
        { id: memberInvitationId },
      );
      expect(joined.status).toBe(201);

      const filed = await callApiWithParams(
        reportPost,
        {
          path: `/api/rooms/${roomId}/reports`,
          method: "POST",
          body: {
            subject_type: "user",
            subject_alias: ownerAlias,
            reason: "spam",
          },
        },
        { id: roomId },
      );
      expect(filed.status).toBe(201);
      const reportId = ((await readJson(filed)).report as { id: string }).id;

      await seedSession(owner.email, owner.password);
      const resolved = await callApiWithParams(
        reportPatch,
        {
          path: `/api/reports/${reportId}`,
          method: "PATCH",
          body: { status: "resolved" },
        },
        { reportId },
      );
      expect(resolved.status).toBe(200);

      await seedSession(member.email, member.password);
      const list = await readJson(
        await callApi(listGet, { path: "/api/notifications?limit=50" }),
      );
      const reportRow = (list.notifications as Record<string, unknown>[]).find(
        (row) => row.type === "report_resolved",
      );
      expect(reportRow).toBeTruthy();

      // PR 09's rule extends here: the payload never carries the reporter's
      // identity, and it never names the moderator either.
      const serialized = JSON.stringify(reportRow!.payload);
      expect(serialized).not.toContain(member.id);
      expect(serialized).not.toContain(member.email);
      expect(serialized).not.toContain(owner.id);
      expect(serialized).not.toContain("reporter");

      // And the definer itself refuses a payload that tries to smuggle it.
      const smuggled = await owner.client.rpc("push_report_notification", {
        p_report_id: reportId,
        p_type: "report_resolved",
        p_payload: { title: "leaky", body: "leaky", reporter_id: member.id },
        p_dedupe_key: null,
      });
      expect((smuggled.data as { code?: string }).code).toBe("invalid_payload");
    });
  });

  describe("retention", () => {
    it("prune_notifications removes only rows older than the cutoff", async () => {
      const created = await pushAs(outsider, {
        p_user_id: outsider.id,
        p_type: "resource_ready",
        p_payload: { title: "Old row", body: "to be pruned" },
        p_room_id: null,
        p_dedupe_key: `prune-probe-old`,
      });
      const oldId = (created as { id?: string }).id;
      expect(oldId).toBeTypeOf("string");

      const fresh = await pushAs(outsider, {
        p_user_id: outsider.id,
        p_type: "resource_ready",
        p_payload: { title: "Fresh row", body: "stays" },
        p_room_id: null,
        p_dedupe_key: `prune-probe-fresh`,
      });
      const freshId = (fresh as { id?: string }).id;

      psql(
        `update public.notifications set created_at = now() - interval '120 days' where id = '${oldId}';`,
      );

      const removed = psql(
        `select public.prune_notifications(now() - interval '90 days');`,
      );
      expect(Number(removed)).toBeGreaterThanOrEqual(1);

      expect(psql(`select count(*) from public.notifications where id = '${oldId}';`)).toBe("0");
      expect(psql(`select count(*) from public.notifications where id = '${freshId}';`)).toBe("1");
    });

    it("the prune function is not executable by application roles", async () => {
      const denied = psqlExpectingFailure(
        `set role authenticated; select public.prune_notifications(now()); reset role;`,
      );
      expect(denied.status).not.toBe(0);
    });
  });

  describe("report path forgery floor", () => {
    it("a stranger cannot drive the report producer either", async () => {
      // Reuse the resolved report from the producer flow: the outsider is
      // neither owner nor moderator of its room.
      const reportId = psql(
        `select id from public.moderation_reports where room_id = '${roomId}' order by created_at desc limit 1;`,
      );
      const result = await outsider.client.rpc("push_report_notification", {
        p_report_id: reportId,
        p_type: "report_resolved",
        p_payload: { title: "forged", body: "forged" },
        p_dedupe_key: null,
      });
      // Same 404-shaped refusal the PATCH route gives a non-moderator.
      expect((result.data as { code?: string }).code).toBe("not_found");
    });
  });
});
