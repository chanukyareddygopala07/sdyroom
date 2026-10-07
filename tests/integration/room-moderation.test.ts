import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as acceptPost } from "@/app/api/invitations/[id]/accept/route";
import { DELETE as blockDelete } from "@/app/api/blocks/[alias]/route";
import { GET as blocksGet, POST as blocksPost } from "@/app/api/blocks/route";
import { POST as invitePost } from "@/app/api/rooms/[id]/invitations/route";
import { DELETE as memberDelete } from "@/app/api/rooms/[id]/members/[alias]/route";
import {
  DELETE as moderatorDelete,
  POST as moderatorPost,
} from "@/app/api/rooms/[id]/members/[alias]/moderator/route";
import {
  DELETE as muteDelete,
  POST as mutePost,
} from "@/app/api/rooms/[id]/members/[alias]/mute/route";
import { GET as membersGet } from "@/app/api/rooms/[id]/members/route";
import {
  GET as messagesGet,
  POST as messagesPost,
} from "@/app/api/rooms/[id]/messages/route";
import { GET as reportsGet, POST as reportsPost } from "@/app/api/rooms/[id]/reports/route";
import { PATCH as reportPatch } from "@/app/api/reports/[reportId]/route";
import { setModerator } from "@/lib/moderation/queries";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql, psqlExpectingFailure } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
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

type MessageView = { id: string; alias: string; body: string };

/**
 * The PR-09 security matrix end to end: reports (with reporter privacy),
 * report workflow, mutes, moderator appointments, blocks (with the chat
 * filter), member removal, audit rows, grant probes, cross-room isolation,
 * and a rolled-back control that proves the probes would notice a widening.
 *
 * Fixture — room A (public): owner, mod (appointed moderator), reporter,
 * victim, muted. Room B (public, owned by outsider): reporter + victim.
 * Private room P (owned by reporter, created mid-suite): the blocked
 * invitation. `outsider` holds a profile but no membership in room A.
 */
describe("room moderation", () => {
  let owner: TestUser;
  let mod: TestUser;
  let reporter: TestUser;
  let victim: TestUser;
  let muted: TestUser;
  let outsider: TestUser;

  let ownerAlias: string;
  let modAlias: string;
  let reporterAlias: string;
  let victimAlias: string;
  let mutedAlias: string;
  let outsiderAlias: string;

  let roomId: string;
  let foreignRoomId: string;
  let blockedRoomId: string;
  let victimMessageId: string;
  let foreignMessageId: string;
  let reportId: string;
  let foreignReportId: string;

  beforeAll(async () => {
    [owner, mod, reporter, victim, muted, outsider] = await Promise.all([
      createUser("moda-owner"),
      createUser("moda-mod"),
      createUser("moda-reporter"),
      createUser("moda-victim"),
      createUser("moda-muted"),
      createUser("moda-outsider"),
    ]);

    const registered = await Promise.all(
      [
        [owner, "MO"],
        [mod, "MM"],
        [reporter, "MR"],
        [victim, "MV"],
        [muted, "MF"],
        [outsider, "ME"],
      ].map(async ([user, label]) => {
        const alias = uniqueAlias(label as string);
        await createProfile((user as TestUser).client, (user as TestUser).id, alias);
        return alias;
      }),
    );
    [ownerAlias, modAlias, reporterAlias, victimAlias, mutedAlias, outsiderAlias] =
      registered;

    roomId = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("ModRoomA"), capacity: 6 }),
      )
    ).id;
    for (const user of [mod, reporter, victim, muted]) {
      await joinRoom(user.client, roomId);
    }
    await setModerator(owner.client, roomId, modAlias, true);

    foreignRoomId = (
      await createRoom(
        outsider.client,
        createRoomSchema.parse({ name: uniqueName("ModRoomB"), capacity: 6 }),
      )
    ).id;
    await joinRoom(reporter.client, foreignRoomId);
    await joinRoom(victim.client, foreignRoomId);

    await seedSession(victim.email, victim.password);
    const victimMessage = await postMessage({ body: "original post" });
    expect(victimMessage.response.status).toBe(201);
    victimMessageId = (victimMessage.body.message as MessageView).id;

    await seedSession(outsider.email, outsider.password);
    const foreignMessage = await postMessage(
      { body: "foreign room post" },
      foreignRoomId,
    );
    expect(foreignMessage.response.status).toBe(201);
    foreignMessageId = (foreignMessage.body.message as MessageView).id;
  });

  afterAll(async () => {
    clearCookies();
    await deleteUsers([owner, mod, reporter, victim, muted, outsider]);
  });

  async function as(user: TestUser): Promise<void> {
    await seedSession(user.email, user.password);
  }

  function postMessage(body: unknown, roomArg: string = roomId) {
    return callApiWithParams(
      messagesPost,
      { path: `/api/rooms/${roomArg}/messages`, method: "POST", body },
      { id: roomArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  async function send(user: TestUser, text: string, roomArg: string = roomId) {
    await as(user);
    const { response, body } = await postMessage({ body: text }, roomArg);
    expect(response.status).toBe(201);
    return body.message as MessageView;
  }

  function getMessages(query = "", roomArg: string = roomId) {
    return callApiWithParams(
      messagesGet,
      { path: `/api/rooms/${roomArg}/messages${query}` },
      { id: roomArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function messageBodies(body: Record<string, unknown>): string[] {
    const messages = body.messages;
    if (!Array.isArray(messages)) {
      throw new Error(`Expected { messages: [...] }, got ${JSON.stringify(body).slice(0, 200)}`);
    }
    return (messages as MessageView[]).map((message) => message.body);
  }

  function fileReport(roomArg: string, payload: unknown) {
    return callApiWithParams(
      reportsPost,
      { path: `/api/rooms/${roomArg}/reports`, method: "POST", body: payload },
      { id: roomArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function listReports(roomArg: string) {
    return callApiWithParams(
      reportsGet,
      { path: `/api/rooms/${roomArg}/reports` },
      { id: roomArg },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function patchReport(id: string, payload: unknown) {
    return callApiWithParams(
      reportPatch,
      { path: `/api/reports/${id}`, method: "PATCH", body: payload },
      { reportId: id },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  function memberAction(
    handler: (
      request: import("next/server").NextRequest,
      context: { params: Promise<{ id: string; alias: string }> },
    ) => Promise<Response>,
    method: string,
    alias: string,
    payload?: unknown,
  ) {
    return callApiWithParams(
      handler,
      {
        path: `/api/rooms/${roomId}/members/${encodeURIComponent(alias)}`,
        method,
        ...(payload !== undefined ? { body: payload } : {}),
      },
      { id: roomId, alias },
    ).then(async (response) => ({ response, body: await readJson(response) }));
  }

  describe("authentication", () => {
    it("refuses anonymous reports and blocks with 401", async () => {
      clearCookies();

      const report = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "spam",
      });
      expect(report.response.status).toBe(401);
      expect(errorOf(report.body).code).toBe("unauthenticated");

      const block = await callApi(blocksPost, {
        path: "/api/blocks",
        method: "POST",
        body: { alias: victimAlias },
      }).then(async (response) => ({ response, body: await readJson(response) }));
      expect(block.response.status).toBe(401);
      expect(errorOf(block.body).code).toBe("unauthenticated");

      const list = await callApi(blocksGet, { path: "/api/blocks" }).then(
        async (response) => ({ response, body: await readJson(response) }),
      );
      expect(list.response.status).toBe(401);
      expect(errorOf(list.body).code).toBe("unauthenticated");
    });
  });

  describe("reports", () => {
    it("files a message report, records the reporter privately, and repeats idempotently", async () => {
      await as(reporter);
      const created = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "harassment",
        detail: "Targeted abuse in chat.",
      });
      expect(created.response.status).toBe(201);
      const report = created.body.report as { id: string; status: string };
      expect(report.id).toMatch(UUID_RE);
      expect(report.status).toBe("pending");
      reportId = report.id;

      // The row's reporter is the session's uid — never anything a body said.
      expect(
        psql(`select reporter_id from public.moderation_reports where id = '${reportId}';`),
      ).toBe(reporter.id);

      const duplicate = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "harassment",
        detail: "A different detail for the same open subject.",
      });
      expect(duplicate.response.status).toBe(200);
      expect(duplicate.body.duplicate).toBe(true);
      expect((duplicate.body.report as { id: string }).id).toBe(reportId);
      expect(
        psql(
          `select count(*) from public.moderation_reports where room_id = '${roomId}';`,
        ),
      ).toBe("1");
    });

    it("rejects a smuggled reporter id and any field outside the schema", async () => {
      await as(reporter);
      const forged = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "spam",
        reporter_id: outsider.id,
      });
      expect(forged.response.status).toBe(400);
      expect(errorOf(forged.body).code).toBe("validation");

      const unknownField = await fileReport(roomId, {
        subject_type: "user",
        subject_alias: victimAlias,
        reason: "spam",
        subject_user_id: victim.id,
      });
      expect(unknownField.response.status).toBe(400);
      expect(errorOf(unknownField.body).code).toBe("validation");
    });

    it("keeps the reporter invisible to the moderator view and to PostgREST", async () => {
      await as(mod);
      const inbox = await listReports(roomId);
      expect(inbox.response.status).toBe(200);
      const raw = JSON.stringify(inbox.body);
      expect(raw).not.toContain("reporter_id");
      expect(raw).not.toContain(reporter.id);
      expect((inbox.body.count as number)).toBe(1);
      const listed = (inbox.body.reports as Record<string, unknown>[])[0];
      expect(listed.id).toBe(reportId);
      expect(listed.subject_alias).toBe(victimAlias);
      expect(listed.resolved_by).toBeNull();

      // Column-grant probe: no role — not even the reporter's — can read it.
      expect(
        psql(
          "select has_column_privilege('authenticated', 'public.moderation_reports', 'reporter_id', 'SELECT');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.moderation_reports', 'insert');",
        ),
      ).toBe("f");

      // A direct insert cannot pin another reporter — no grant exists.
      const direct = await reporter.client
        .from("moderation_reports")
        .insert({
          room_id: roomId,
          subject_type: "user",
          subject_id: victim.id,
          reporter_id: outsider.id,
          reason: "spam",
        });
      expect(direct.error).not.toBeNull();
      expect(
        psql(
          `select count(*) from public.moderation_reports where room_id = '${roomId}';`,
        ),
      ).toBe("1");
    });

    it("refuses self-reports, foreign-room subjects, and out-of-enum reasons", async () => {
      await as(reporter);
      const ownMessage = await send(reporter, "my own words");
      const selfReport = await fileReport(roomId, {
        subject_type: "message",
        subject_id: ownMessage.id,
        reason: "other",
      });
      expect(selfReport.response.status).toBe(409);
      expect(errorOf(selfReport.body).code).toBe("self_report");

      const foreignSubject = await fileReport(roomId, {
        subject_type: "message",
        subject_id: foreignMessageId,
        reason: "spam",
      });
      expect(foreignSubject.response.status).toBe(404);
      expect(errorOf(foreignSubject.body).code).toBe("not_found");

      const stranger = await fileReport(roomId, {
        subject_type: "user",
        subject_alias: outsiderAlias,
        reason: "spam",
      });
      expect(stranger.response.status).toBe(404);
      expect(errorOf(stranger.body).code).toBe("not_found");

      const badReason = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "not_a_reason",
      });
      expect(badReason.response.status).toBe(400);
      expect(errorOf(badReason.body).code).toBe("validation");

      const overDetail = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "other",
        detail: "x".repeat(501),
      });
      expect(overDetail.response.status).toBe(400);
      expect(errorOf(overDetail.body).code).toBe("validation");
    });

    it("keeps non-members at 404 and plain members off the inbox", async () => {
      await as(outsider);
      const outsiderPost = await fileReport(roomId, {
        subject_type: "message",
        subject_id: victimMessageId,
        reason: "spam",
      });
      expect(outsiderPost.response.status).toBe(404);
      expect(errorOf(outsiderPost.body).code).toBe("not_found");

      const outsiderInbox = await listReports(roomId);
      expect(outsiderInbox.response.status).toBe(404);
      expect(errorOf(outsiderInbox.body).code).toBe("not_found");

      await as(reporter);
      const memberInbox = await listReports(roomId);
      expect(memberInbox.response.status).toBe(403);
      expect(errorOf(memberInbox.body).code).toBe("not_moderator");
      expect(
        psql(
          `select count(*) from public.moderation_reports where room_id = '${roomId}';`,
        ),
      ).toBe("1");
    });

    it("advances the report through reviewing to resolved with one audit row each", async () => {
      await as(mod);
      const reviewing = await patchReport(reportId, { status: "reviewing" });
      expect(reviewing.response.status).toBe(200);
      expect((reviewing.body.report as { status: string }).status).toBe("reviewing");
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and action = 'report_reviewed';`,
        ),
      ).toBe("1");

      const resolved = await patchReport(reportId, { status: "resolved" });
      expect(resolved.response.status).toBe(200);
      expect((resolved.body.report as { status: string }).status).toBe("resolved");
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and action = 'report_resolved';`,
        ),
      ).toBe("1");
      expect(
        psql(
          `select resolved_by from public.moderation_reports where id = '${reportId}';`,
        ),
      ).toBe(mod.id);

      // Terminal states never reopen.
      const reopen = await patchReport(reportId, { status: "reviewing" });
      expect(reopen.response.status).toBe(409);
      expect(errorOf(reopen.body).code).toBe("invalid_transition");

      const pending = await patchReport(reportId, { status: "pending" });
      expect(pending.response.status).toBe(400);
      expect(errorOf(pending.body).code).toBe("validation");

      // The report's subject (reporter) and an outsider learn nothing: 404,
      // identical to a missing id — no existence oracle.
      await as(reporter);
      const byReporter = await patchReport(reportId, { status: "dismissed" });
      expect(byReporter.response.status).toBe(404);
      expect(errorOf(byReporter.body).code).toBe("not_found");

      await as(outsider);
      const byOutsider = await patchReport(reportId, { status: "dismissed" });
      expect(byOutsider.response.status).toBe(404);
      expect(errorOf(byOutsider.body).code).toBe("not_found");

      // The moderator view now shows the resolution without a reporter id.
      await as(mod);
      const inbox = await listReports(roomId);
      const listed = (inbox.body.reports as Record<string, unknown>[])[0];
      expect(listed.status).toBe("resolved");
      expect(listed.resolved_by).toBe(modAlias);
      expect(JSON.stringify(inbox.body)).not.toContain("reporter_id");
    });
  });

  describe("mutes", () => {
    it("mutes through the API and blocks the target's sends at the database", async () => {
      await as(owner);
      const mutedResponse = await memberAction(mutePost, "POST", mutedAlias, {
        duration: "1h",
      });
      expect(mutedResponse.response.status).toBe(201);
      const until = new Date(String((mutedResponse.body as { muted_until: string }).muted_until));
      expect(until.getTime()).toBeGreaterThan(Date.now());
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and action = 'mute_applied' and actor_id = '${owner.id}';`,
        ),
      ).toBe("1");

      // API send: honest 403 with the dedicated code.
      await as(muted);
      const send = await postMessage({ body: "evasion attempt" });
      expect(send.response.status).toBe(403);
      expect(errorOf(send.body).code).toBe("muted");

      // Direct PostgREST insert: RLS `with check` refuses it outright.
      const direct = await muted.client.from("room_messages").insert({
        room_id: roomId,
        user_id: muted.id,
        alias: mutedAlias,
        body: "direct evasion",
      });
      expect(direct.error).not.toBeNull();
      expect(direct.error?.code).toBe("42501");
      expect(
        psql(
          `select count(*) from public.room_messages where room_id = '${roomId}' and body like '%evasion%';`,
        ),
      ).toBe("0");
    });

    it("answers a repeat mute 409 and exposes only the caller's own mute row", async () => {
      await as(owner);
      const repeat = await memberAction(mutePost, "POST", mutedAlias, {
        duration: "24h",
      });
      expect(repeat.response.status).toBe(409);
      expect(errorOf(repeat.body).code).toBe("already_muted");

      // Own-row slice: the muted member sees their row, the moderator does
      // not, so reading `room_mutes` cannot enumerate a room's mutes.
      const own = await muted.client.from("room_mutes").select("*");
      expect(own.error).toBeNull();
      expect(own.data?.length).toBe(1);

      const asMod = await mod.client.from("room_mutes").select("*");
      expect(asMod.error).toBeNull();
      expect(asMod.data?.length).toBe(0);
    });

    it("lifts the mute and restores sending", async () => {
      await as(reporter);
      const notModerator = await memberAction(muteDelete, "DELETE", mutedAlias);
      expect(notModerator.response.status).toBe(403);
      expect(errorOf(notModerator.body).code).toBe("not_moderator");

      await as(owner);
      const lifted = await memberAction(muteDelete, "DELETE", mutedAlias);
      expect(lifted.response.status).toBe(200);
      expect(lifted.body.unmuted).toBe(true);
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and action = 'mute_lifted';`,
        ),
      ).toBe("1");

      const again = await memberAction(muteDelete, "DELETE", mutedAlias);
      expect(again.response.status).toBe(409);
      expect(errorOf(again.body).code).toBe("not_muted");

      const restored = await send(muted, "back to normal");
      expect(restored.body).toBeDefined();
    });

    it("refuses mute of the owner, a moderator, or oneself", async () => {
      await as(mod);
      const ownerTarget = await memberAction(mutePost, "POST", ownerAlias, {
        duration: "1h",
      });
      expect(ownerTarget.response.status).toBe(403);
      expect(errorOf(ownerTarget.body).code).toBe("cannot_mute_owner");

      await as(owner);
      const modTarget = await memberAction(mutePost, "POST", modAlias, {
        duration: "1h",
      });
      expect(modTarget.response.status).toBe(403);
      expect(errorOf(modTarget.body).code).toBe("cannot_mute_moderator");

      // Self first: an owner or moderator attempting their own mute gets the
      // specific refusal, not the target rule their own role would trigger.
      await as(mod);
      const self = await memberAction(mutePost, "POST", modAlias, {
        duration: "1h",
      });
      expect(self.response.status).toBe(403);
      expect(errorOf(self.body).code).toBe("cannot_mute_self");

      // A plain member never reaches the target rules at all.
      await as(reporter);
      const memberAttempt = await memberAction(mutePost, "POST", mutedAlias, {
        duration: "1h",
      });
      expect(memberAttempt.response.status).toBe(403);
      expect(errorOf(memberAttempt.body).code).toBe("not_moderator");

      await as(mod);
      const badDuration = await memberAction(mutePost, "POST", mutedAlias, {
        duration: "99h",
      });
      expect(badDuration.response.status).toBe(400);
      expect(errorOf(badDuration.body).code).toBe("validation");
    });
  });

  describe("moderator appointments", () => {
    it("lets only the owner appoint, and grants work immediately", async () => {
      await as(reporter);
      const notOwner = await memberAction(moderatorPost, "POST", mutedAlias);
      expect(notOwner.response.status).toBe(403);
      expect(errorOf(notOwner.body).code).toBe("not_owner");

      await as(owner);
      const appointed = await memberAction(moderatorPost, "POST", mutedAlias);
      expect(appointed.response.status).toBe(200);
      expect(appointed.body).toMatchObject({ role: "moderator", changed: true, granted: true });
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and action = 'moderator_appointed' and actor_id = '${owner.id}';`,
        ),
      ).toBe("2"); // mod at setup + muted here

      // The appointee's first moderator right: read the inbox.
      await as(muted);
      const inbox = await listReports(roomId);
      expect(inbox.response.status).toBe(200);
    });

    it("revokes immediately, refuses the owner as a target, and stays owner-only", async () => {
      await as(owner);
      const revoked = await memberAction(moderatorDelete, "DELETE", mutedAlias);
      expect(revoked.response.status).toBe(200);
      expect(revoked.body).toMatchObject({ role: "student", changed: true });

      await as(muted);
      const afterRevoke = await listReports(roomId);
      expect(afterRevoke.response.status).toBe(403);
      expect(errorOf(afterRevoke.body).code).toBe("not_moderator");

      await as(owner);
      const ownerTarget = await memberAction(moderatorPost, "POST", ownerAlias);
      expect(ownerTarget.response.status).toBe(403);
      expect(errorOf(ownerTarget.body).code).toBe("cannot_moderate_owner");

      const unknown = await memberAction(moderatorPost, "POST", "ghostalias");
      expect(unknown.response.status).toBe(404);
      expect(errorOf(unknown.body).code).toBe("not_found");

      // Bodyless contract: any field is a 400, not an ignored suggestion.
      const withBody = await memberAction(moderatorPost, "POST", mutedAlias, {
        on: false,
      });
      expect(withBody.response.status).toBe(400);
      expect(errorOf(withBody.body).code).toBe("invalid_request");

      // A moderator cannot mint or revoke moderators.
      await as(mod);
      const modAppoint = await memberAction(moderatorPost, "POST", reporterAlias);
      expect(modAppoint.response.status).toBe(403);
      expect(errorOf(modAppoint.body).code).toBe("not_owner");
      expect(
        psql(
          `select count(*) from public.room_moderators where room_id = '${roomId}';`,
        ),
      ).toBe("1"); // only mod remains
    });
  });

  describe("blocks", () => {
    it("creates idempotently, refuses self and unknown targets", async () => {
      await as(reporter);
      const created = await callApi(blocksPost, {
        path: "/api/blocks",
        method: "POST",
        body: { alias: victimAlias },
      }).then(async (response) => ({ response, body: await readJson(response) }));
      expect(created.response.status).toBe(201);
      expect(created.body.created).toBe(true);

      const repeat = await callApi(blocksPost, {
        path: "/api/blocks",
        method: "POST",
        body: { alias: victimAlias },
      }).then(async (response) => ({ response, body: await readJson(response) }));
      expect(repeat.response.status).toBe(200);
      expect(repeat.body.created).toBe(false);

      const self = await callApi(blocksPost, {
        path: "/api/blocks",
        method: "POST",
        body: { alias: reporterAlias },
      }).then(async (response) => ({ response, body: await readJson(response) }));
      expect(self.response.status).toBe(409);
      expect(errorOf(self.body).code).toBe("self_block");

      const unknown = await callApi(blocksPost, {
        path: "/api/blocks",
        method: "POST",
        body: { alias: "ghostalias" },
      }).then(async (response) => ({ response, body: await readJson(response) }));
      expect(unknown.response.status).toBe(404);
      expect(errorOf(unknown.body).code).toBe("not_found");

      const empty = await callApi(blocksPost, {
        path: "/api/blocks",
        method: "POST",
        body: { alias: "" },
      }).then(async (response) => ({ response, body: await readJson(response) }));
      expect(empty.response.status).toBe(400);
      expect(errorOf(empty.body).code).toBe("validation");
    });

    it("shows each user only their own blocks", async () => {
      await as(reporter);
      const mine = await callApi(blocksGet, { path: "/api/blocks" }).then(
        async (response) => ({ response, body: await readJson(response) }),
      );
      expect(mine.response.status).toBe(200);
      expect(
        (mine.body.blocks as { alias: string }[]).map((block) => block.alias),
      ).toEqual([victimAlias]);

      const direct = await reporter.client.from("user_blocks").select("*");
      expect(direct.error).toBeNull();
      expect(direct.data?.length).toBe(1);

      await as(mod);
      const theirs = await callApi(blocksGet, { path: "/api/blocks" }).then(
        async (response) => ({ response, body: await readJson(response) }),
      );
      expect(theirs.response.status).toBe(200);
      expect(theirs.body.count).toBe(0);

      const directOther = await mod.client.from("user_blocks").select("*");
      expect(directOther.error).toBeNull();
      expect(directOther.data?.length).toBe(0);
    });

    it("filters the blocked user's messages for the blocker only — old and new", async () => {
      // History endpoint: the blocker no longer sees the pre-block message.
      await as(reporter);
      const blockedHistory = await getMessages("?limit=50");
      expect(blockedHistory.response.status).toBe(200);
      const reporterView = messageBodies(blockedHistory.body);
      expect(reporterView).not.toContain("original post");

      // Direct select: same rule, straight from PostgREST.
      const direct = await reporter.client
        .from("room_messages")
        .select("body")
        .eq("room_id", roomId);
      expect(direct.error).toBeNull();
      expect((direct.data ?? []).map((row) => row.body)).not.toContain("original post");

      // Everyone else still sees it (the filter is one-way).
      await as(mod);
      const modHistory = await getMessages("?limit=50");
      expect(messageBodies(modHistory.body)).toContain("original post");

      await as(victim);
      const ownHistory = await getMessages("?limit=50");
      expect(messageBodies(ownHistory.body)).toContain("original post");

      // New sends from the blocked user stay invisible to the blocker…
      const newFromVictim = await send(victim, "still shouting");
      expect(newFromVictim.id).toMatch(UUID_RE);
      await as(reporter);
      const afterSend = await getMessages("?limit=50");
      expect(messageBodies(afterSend.body)).not.toContain("still shouting");

      // …while the blocked user keeps receiving the blocker's messages.
      const fromReporter = await send(reporter, "hello from the blocker");
      expect(fromReporter.id).toMatch(UUID_RE);
      await as(victim);
      const victimView = await getMessages("?limit=50");
      expect(messageBodies(victimView.body)).toContain("hello from the blocker");
      expect(messageBodies(victimView.body)).toContain("original post");
    });

    it("blocks invitation acceptance until unblocked, then restores", async () => {
      await as(reporter);
      blockedRoomId = (
        await createRoom(
          reporter.client,
          createRoomSchema.parse({
            name: uniqueName("ModPrivate"),
            visibility: "private",
          }),
        )
      ).id;

      const invited = await callApiWithParams(
        invitePost,
        {
          path: `/api/rooms/${blockedRoomId}/invitations`,
          method: "POST",
          body: { invitee_alias: victimAlias },
        },
        { id: blockedRoomId },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(invited.response.status).toBeLessThan(300);

      await as(victim);
      const refused = await callApiWithParams(
        acceptPost,
        {
          path: `/api/invitations/${(invited.body.invitation as { id: string }).id}/accept`,
          method: "POST",
        },
        {
          id: (invited.body.invitation as { id: string }).id,
        },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(refused.response.status).toBe(409);
      expect(errorOf(refused.body).code).toBe("blocked");

      // The invitation is left pending — the blocker is never notified and
      // nothing is destroyed.
      expect(
        psql(
          `select status from public.room_invitations where id = '${(invited.body.invitation as { id: string }).id}';`,
        ),
      ).toBe("pending");

      // Unblock, then the same acceptance succeeds.
      await as(reporter);
      const removed = await callApiWithParams(
        blockDelete,
        {
          path: `/api/blocks/${encodeURIComponent(victimAlias)}`,
          method: "DELETE",
        },
        { alias: victimAlias },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(removed.response.status).toBe(200);
      expect(removed.body.removed).toBe(true);

      const again = await callApiWithParams(
        blockDelete,
        {
          path: `/api/blocks/${encodeURIComponent(victimAlias)}`,
          method: "DELETE",
        },
        { alias: victimAlias },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(again.response.status).toBe(200);
      expect(again.body.removed).toBe(false);

      await as(victim);
      const accepted = await callApiWithParams(
        acceptPost,
        {
          path: `/api/invitations/${(invited.body.invitation as { id: string }).id}/accept`,
          method: "POST",
        },
        { id: (invited.body.invitation as { id: string }).id },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(accepted.response.status).toBe(201);
      expect(accepted.body.membership).toBe("joined");

      // With the block gone, the old message is visible to the ex-blocker.
      await as(reporter);
      const restoredHistory = await getMessages("?limit=50");
      expect(messageBodies(restoredHistory.body)).toContain("original post");
    });
  });

  describe("member removal", () => {
    it("lets the moderator remove a member and refuses the wrong actors and targets", async () => {
      await as(outsider);
      const outsiderRemove = await memberAction(memberDelete, "DELETE", victimAlias);
      expect(outsiderRemove.response.status).toBe(404);
      expect(errorOf(outsiderRemove.body).code).toBe("not_found");

      await as(reporter);
      const memberRemove = await memberAction(memberDelete, "DELETE", victimAlias);
      expect(memberRemove.response.status).toBe(403);
      expect(errorOf(memberRemove.body).code).toBe("not_moderator");

      await as(mod);
      const removed = await memberAction(memberDelete, "DELETE", victimAlias);
      expect(removed.response.status).toBe(200);
      expect(removed.body.removed).toBe(true);
      expect(removed.body.member_count).toBe(4); // owner, mod, reporter, muted
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and action = 'member_removed' and actor_id = '${mod.id}';`,
        ),
      ).toBe("1");
      expect(
        psql(
          `select count(*) from public.room_members where room_id = '${roomId}';`,
        ),
      ).toBe("4");

      await as(owner);
      const ownerTarget = await memberAction(memberDelete, "DELETE", ownerAlias);
      expect(ownerTarget.response.status).toBe(403);
      expect(errorOf(ownerTarget.body).code).toBe("cannot_remove_owner");

      await as(mod);
      const selfRemove = await memberAction(memberDelete, "DELETE", modAlias);
      expect(selfRemove.response.status).toBe(403);
      expect(errorOf(selfRemove.body).code).toBe("cannot_remove_self");

      // Room B's membership is untouchable from room A.
      await as(owner);
      const crossRoom = await callApiWithParams(
        memberDelete,
        {
          path: `/api/rooms/${foreignRoomId}/members/${encodeURIComponent(reporterAlias)}`,
          method: "DELETE",
        },
        { id: foreignRoomId, alias: reporterAlias },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(crossRoom.response.status).toBe(404);
      expect(
        psql(
          `select count(*) from public.room_members where room_id = '${foreignRoomId}';`,
        ),
      ).toBe("3"); // outsider, reporter, victim — untouched
    });

    it("locks the removed member out of the roster, reads, writes, and presence", async () => {
      await as(victim);

      const roster = await callApiWithParams(
        membersGet,
        { path: `/api/rooms/${roomId}/members` },
        { id: roomId },
      ).then(async (response) => ({ response, body: await readJson(response) }));
      expect(roster.response.status).toBe(404);
      expect(errorOf(roster.body).code).toBe("not_found");

      const read = await getMessages("?limit=50");
      expect(read.response.status).toBe(404);

      const write = await postMessage({ body: "one more try" });
      expect(write.response.status).toBe(404);

      const directInsert = await victim.client.from("room_messages").insert({
        room_id: roomId,
        user_id: victim.id,
        alias: victimAlias,
        body: "direct try",
      });
      expect(directInsert.error).not.toBeNull();

      const directSelect = await victim.client
        .from("room_messages")
        .select("body")
        .eq("room_id", roomId);
      expect(directSelect.error).toBeNull();
      expect(directSelect.data ?? []).toEqual([]);
    });

    it("keeps a removed member out of the presence channel", async () => {
      const topic = `room-presence-${roomId}`;

      // A current member's insert is allowed (positive control).
      const allowed = psql(
        [
          "begin;",
          "set local role authenticated;",
          `set local request.jwt.claims to '{"sub":"${muted.id}","role":"authenticated"}';`,
          `insert into realtime.messages (topic, extension) values ('${topic}', 'presence');`,
          "rollback;",
        ].join("\n"),
      );
      expect(allowed).toContain("INSERT 0 1");

      // The removed member is refused by the policy — RLS at the database.
      const refused = psqlExpectingFailure(
        [
          "begin;",
          "set local role authenticated;",
          `set local request.jwt.claims to '{"sub":"${victim.id}","role":"authenticated"}';`,
          `insert into realtime.messages (topic, extension) values ('${topic}', 'presence');`,
          "rollback;",
        ].join("\n"),
      );
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain("row-level security");
    });
  });

  describe("cross-room isolation", () => {
    it("keeps each room's inbox and audit trail separate", async () => {
      await as(reporter);
      const foreign = await fileReport(foreignRoomId, {
        subject_type: "message",
        subject_id: foreignMessageId,
        reason: "spam",
        detail: "Report filed in room B.",
      });
      expect(foreign.response.status).toBe(201);
      foreignReportId = (foreign.body.report as { id: string }).id;
      expect(foreignReportId).not.toBe(reportId);

      await as(mod);
      const inboxA = await listReports(roomId);
      const idsA = (inboxA.body.reports as { id: string }[]).map((entry) => entry.id);
      expect(idsA).toContain(reportId);
      expect(idsA).not.toContain(foreignReportId);

      await as(outsider);
      const inboxB = await listReports(foreignRoomId);
      expect(inboxB.response.status).toBe(200);
      const idsB = (inboxB.body.reports as { id: string }[]).map((entry) => entry.id);
      expect(idsB).toEqual([foreignReportId]);
      expect(idsB).not.toContain(reportId);

      // The foreign report's room audit never bleeds into room A either.
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}';`,
        ),
      ).toBe("8");
    });
  });

  describe("grants, audit, and the control violation", () => {
    it("keeps every moderation table at RPC-only posture", () => {
      const probes: [string, string, string][] = [
        ["moderation_reports", "select", "f"],
        ["moderation_reports", "insert", "f"],
        ["moderation_actions", "select", "f"],
        ["moderation_actions", "insert", "f"],
        ["moderation_actions", "update", "f"],
        ["moderation_actions", "delete", "f"],
        ["room_moderators", "select", "f"],
        ["room_moderators", "insert", "f"],
        ["room_mutes", "insert", "f"],
        ["user_blocks", "insert", "f"],
        ["room_messages", "update", "f"],
        ["room_messages", "delete", "f"],
      ];
      for (const [table, privilege, expected] of probes) {
        expect(
          psql(
            `select has_table_privilege('authenticated', 'public.${table}', '${privilege}');`,
          ),
          `${table}.${privilege}`,
        ).toBe(expected);
      }

      // The two policy-referenced tables carry exactly the reads they need.
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.user_blocks', 'select');",
        ),
      ).toBe("t");
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.room_mutes', 'select');",
        ),
      ).toBe("t");

      // Own-row policies only — no permissive anything.
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'public' " +
            "and tablename in ('moderation_reports', 'moderation_actions', 'room_moderators');",
        ),
      ).toBe("0");
    });

    it("writes exactly one audit row per action, always stamped with the actor", () => {
      const rows = psql(
        `select action || ':' || count(*) from public.moderation_actions ` +
          `where room_id = '${roomId}' group by action order by action;`,
      );
      expect(rows.split("\n").sort()).toEqual(
        [
          "member_removed:1",
          "moderator_appointed:2", // mod at setup + muted in this suite
          "moderator_revoked:1",
          "mute_applied:1",
          "mute_lifted:1",
          "report_resolved:1",
          "report_reviewed:1",
        ].sort(),
      );
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}' and actor_id is null;`,
        ),
      ).toBe("0");
    });

    it("control: widening the grants and policy in-transaction lets a direct insert through, and rolls back clean", () => {
      const output = psql(
        [
          "begin;",
          "grant insert on public.moderation_actions to authenticated;",
          "create policy control_insert_widen on public.moderation_actions " +
            "for insert to authenticated with check (true);",
          "set local role authenticated;",
          `set local request.jwt.claims to '{"sub":"${reporter.id}","role":"authenticated"}';`,
          `insert into public.moderation_actions (room_id, actor_id, action, subject_user_id, subject_ref, reason) ` +
            `values ('${roomId}', '${reporter.id}', 'member_removed', null, 'control', null);`,
          "rollback;",
        ].join("\n"),
      );

      // The widening works — which is exactly why the standing probes above
      // must fail if it ever shipped for real.
      expect(output).toContain("INSERT 0 1");

      // Nothing persisted: grants, policies, and rows are back to secure.
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.moderation_actions', 'insert');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'public' and tablename = 'moderation_actions';",
        ),
      ).toBe("0");
      expect(
        psql(
          `select count(*) from public.moderation_actions where room_id = '${roomId}';`,
        ),
      ).toBe("8");

      // And the direct insert is refused again through the real client path.
      return reporter.client
        .from("moderation_actions")
        .insert({
          room_id: roomId,
          actor_id: reporter.id,
          action: "member_removed",
        })
        .then(({ error }) => {
          expect(error).not.toBeNull();
        });
    });
  });

  describe("edge ids", () => {
    it("answers a missing room and a malformed id without leaking", async () => {
      await as(reporter);

      const missingRoom = await fileReport(MISSING_ROOM_ID, {
        subject_type: "user",
        subject_alias: victimAlias,
        reason: "spam",
      });
      expect(missingRoom.response.status).toBe(404);
      expect(errorOf(missingRoom.body).code).toBe("not_found");

      const badPatch = await patchReport("not-a-uuid", { status: "resolved" });
      expect(badPatch.response.status).toBe(400);
      expect(errorOf(badPatch.body).code).toBe("validation");

      const badRoom = await fileReport("not-a-uuid", {
        subject_type: "user",
        subject_alias: victimAlias,
        reason: "spam",
      });
      expect(badRoom.response.status).toBe(400);
      expect(errorOf(badRoom.body).code).toBe("validation");
    });
  });
});
