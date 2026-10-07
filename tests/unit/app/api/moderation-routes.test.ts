import { POST as reportsPost } from "@/app/api/rooms/[id]/reports/route";
import { GET as reportsGet } from "@/app/api/rooms/[id]/reports/route";
import { PATCH as reportPatch } from "@/app/api/reports/[reportId]/route";
import { POST as blocksPost } from "@/app/api/blocks/route";
import { ModerationError } from "@/lib/moderation/errors";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  requireRoomMembership,
  createReport,
  listReports,
  setReportStatus,
  createBlock,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  requireRoomMembership: vi.fn(),
  createReport: vi.fn(),
  listReports: vi.fn(),
  setReportStatus: vi.fn(),
  createBlock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));

vi.mock("@/lib/moderation/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/queries")>()),
  createReport,
  listReports,
  setReportStatus,
  createBlock,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

function post(body?: string, id: string = ROOM_ID) {
  return [
    new NextRequest(`http://localhost:3000/api/rooms/${id}/reports`, {
      method: "POST",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

function get(id: string = ROOM_ID) {
  return [
    new NextRequest(`http://localhost:3000/api/rooms/${id}/reports`),
    { params: Promise.resolve({ id }) },
  ] as const;
}

function patch(body?: string, id: string = REPORT_ID) {
  return [
    new NextRequest(`http://localhost:3000/api/reports/${id}`, {
      method: "PATCH",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ reportId: id }) },
  ] as const;
}

describe("moderation routes", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    requireRoomMembership.mockResolvedValue(undefined);
    createReport.mockResolvedValue({
      code: "created",
      id: REPORT_ID,
      status: "pending",
      created_at: "2026-10-07T10:00:00.000Z",
    });
    listReports.mockResolvedValue([]);
    setReportStatus.mockResolvedValue({ id: REPORT_ID, status: "reviewing" });
    createBlock.mockResolvedValue({
      alias: "Ada",
      created_at: "2026-10-07T10:00:00.000Z",
      created: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("POST /api/rooms/[id]/reports", () => {
    it("rejects unauthenticated requests before anything else runs", async () => {
      getClaims.mockResolvedValue({ data: null });
      const [request, context] = post("{}");

      const response = await reportsPost(request, context);

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("unauthenticated");
      expect(requireRoomMembership).not.toHaveBeenCalled();
      expect(createReport).not.toHaveBeenCalled();
    });

    it("rejects a smuggled reporter id by field name, before membership", async () => {
      const [request, context] = post(
        JSON.stringify({
          subject_type: "message",
          subject_id: MESSAGE_ID,
          reason: "spam",
          reporter_id: "44444444-4444-4444-8444-444444444444",
        }),
      );

      const response = await reportsPost(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
      expect(requireRoomMembership).not.toHaveBeenCalled();
      expect(createReport).not.toHaveBeenCalled();
    });

    it("rejects a user subject without an alias and a bad reason", async () => {
      const noAlias = await reportsPost(
        ...post(
          JSON.stringify({ subject_type: "user", subject_id: MESSAGE_ID, reason: "spam" }),
        ),
      );
      expect(noAlias.status).toBe(400);
      expect((await noAlias.json()).error.code).toBe("validation");

      const badReason = await reportsPost(
        ...post(
          JSON.stringify({
            subject_type: "user",
            subject_alias: "Ada",
            reason: "not-real",
          }),
        ),
      );
      expect(badReason.status).toBe(400);
      expect((await badReason.json()).error.code).toBe("validation");
      expect(createReport).not.toHaveBeenCalled();
    });

    it("proves membership, then files the parsed subject — 201", async () => {
      const [request, context] = post(
        JSON.stringify({
          subject_type: "message",
          subject_id: MESSAGE_ID,
          reason: "harassment",
          detail: " abusive DMs in chat ",
        }),
      );

      const response = await reportsPost(request, context);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.report).toEqual({
        id: REPORT_ID,
        status: "pending",
        created_at: "2026-10-07T10:00:00.000Z",
      });
      expect(requireRoomMembership).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
      expect(createReport).toHaveBeenCalledWith(
        expect.anything(),
        ROOM_ID,
        expect.objectContaining({
          subject_type: "message",
          subject_id: MESSAGE_ID,
          reason: "harassment",
          detail: "abusive DMs in chat",
        }),
      );
      // Nothing about a reporter ever rides along.
      const input = createReport.mock.calls[0][2] as Record<string, unknown>;
      expect("reporter_id" in input).toBe(false);
    });

    it("answers an idempotent duplicate with 200 and the same report", async () => {
      createReport.mockResolvedValue({
        code: "duplicate",
        id: REPORT_ID,
        status: "reviewing",
      });
      const [request, context] = post(
        JSON.stringify({
          subject_type: "message",
          subject_id: MESSAGE_ID,
          reason: "spam",
        }),
      );

      const response = await reportsPost(request, context);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.duplicate).toBe(true);
      expect(body.report).toEqual({ id: REPORT_ID, status: "reviewing" });
    });

    it("maps RPC failures and a lost seat onto the documented statuses", async () => {
      createReport.mockRejectedValueOnce(
        new ModerationError("self_report", "You cannot report your own content.", 409),
      );
      const selfReport = await reportsPost(
        ...post(
          JSON.stringify({
            subject_type: "user",
            subject_alias: "Ada",
            reason: "other",
          }),
        ),
      );
      expect(selfReport.status).toBe(409);
      expect((await selfReport.json()).error.code).toBe("self_report");

      requireRoomMembership.mockRejectedValueOnce(
        new RoomAccessError("hidden"),
      );
      const lostSeat = await reportsPost(
        ...post(
          JSON.stringify({
            subject_type: "user",
            subject_alias: "Ada",
            reason: "other",
          }),
        ),
      );
      expect(lostSeat.status).toBe(404);
      expect((await lostSeat.json()).error.code).toBe("not_found");

      createReport.mockRejectedValueOnce(new Error("sql exploded"));
      const failed = await reportsPost(
        ...post(
          JSON.stringify({
            subject_type: "user",
            subject_alias: "Ada",
            reason: "other",
          }),
        ),
      );
      expect(failed.status).toBe(500);
      expect((await failed.json()).error.code).toBe("report_failed");
    });
  });

  describe("GET /api/rooms/[id]/reports", () => {
    it("validates the room and the limit before touching the RPC", async () => {
      const badRoom = await reportsGet(...get("not-a-uuid"));
      expect(badRoom.status).toBe(400);
      expect((await badRoom.json()).error.code).toBe("validation");

      const badLimit = await reportsGet(
        new NextRequest(
          `http://localhost:3000/api/rooms/${ROOM_ID}/reports?limit=0`,
        ),
        { params: Promise.resolve({ id: ROOM_ID }) },
      );
      expect(badLimit.status).toBe(400);
      expect((await badLimit.json()).error.code).toBe("validation");
      expect(listReports).not.toHaveBeenCalled();
    });

    it("returns the projection the RPC produced, with its count", async () => {
      listReports.mockResolvedValue([
        { id: REPORT_ID, subject_type: "user", status: "pending" },
      ]);
      const [request, context] = get();

      const response = await reportsGet(request, context);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.count).toBe(1);
      expect(JSON.stringify(body)).not.toContain("reporter_id");
    });

    it("maps a non-moderator's RPC refusal to 403", async () => {
      listReports.mockRejectedValueOnce(
        new ModerationError("not_moderator", "Only moderators.", 403),
      );
      const [request, context] = get();

      const response = await reportsGet(request, context);

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("not_moderator");
    });
  });

  describe("PATCH /api/reports/[reportId]", () => {
    it("rejects an unauthenticated caller and a malformed id", async () => {
      getClaims.mockResolvedValue({ data: null });
      const anonymous = await reportPatch(...patch("{}"));
      expect(anonymous.status).toBe(401);
      expect(setReportStatus).not.toHaveBeenCalled();

      getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
      const badId = await reportPatch(...patch("{}", "not-a-uuid"));
      expect(badId.status).toBe(400);
      expect((await badId.json()).error.code).toBe("validation");
    });

    it("refuses pending and unknown statuses before the RPC", async () => {
      const pending = await reportPatch(
        ...patch(JSON.stringify({ status: "pending" })),
      );
      expect(pending.status).toBe(400);
      expect((await pending.json()).error.code).toBe("validation");

      const unknown = await reportPatch(
        ...patch(JSON.stringify({ status: "archived" })),
      );
      expect(unknown.status).toBe(400);
      expect(setReportStatus).not.toHaveBeenCalled();
    });

    it("passes the transition through and returns the new report state", async () => {
      const [request, context] = patch(
        JSON.stringify({ status: "reviewing" }),
      );

      const response = await reportPatch(request, context);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        report: { id: REPORT_ID, status: "reviewing" },
      });
      expect(setReportStatus).toHaveBeenCalledWith(
        expect.anything(),
        REPORT_ID,
        "reviewing",
      );
    });

    it("maps an invalid transition and a hidden report onto 409 and 404", async () => {
      setReportStatus.mockRejectedValueOnce(
        new ModerationError("invalid_transition", "No reopening.", 409),
      );
      const invalid = await reportPatch(
        ...patch(JSON.stringify({ status: "reviewing" })),
      );
      expect(invalid.status).toBe(409);
      expect((await invalid.json()).error.code).toBe("invalid_transition");

      setReportStatus.mockRejectedValueOnce(
        new ModerationError("not_found", "Hidden.", 404),
      );
      const hidden = await reportPatch(
        ...patch(JSON.stringify({ status: "resolved" })),
      );
      expect(hidden.status).toBe(404);
      expect((await hidden.json()).error.code).toBe("not_found");
    });
  });

  describe("POST /api/blocks", () => {
    it("rejects unknown fields outright", async () => {
      const response = await blocksPost(
        new NextRequest("http://localhost:3000/api/blocks", {
          method: "POST",
          body: JSON.stringify({ alias: "Ada", blocker_id: "someone-else" }),
          headers: { "content-type": "application/json" },
        }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
      expect(createBlock).not.toHaveBeenCalled();
    });

    it("creates a block and reports the idempotent repeat as 200", async () => {
      const created = await blocksPost(
        new NextRequest("http://localhost:3000/api/blocks", {
          method: "POST",
          body: JSON.stringify({ alias: "  Ada " }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(created.status).toBe(201);
      expect((await created.json()).created).toBe(true);
      expect(createBlock).toHaveBeenCalledWith(expect.anything(), "Ada");

      createBlock.mockResolvedValueOnce({
        alias: "Ada",
        created_at: "2026-10-07T10:00:00.000Z",
        created: false,
      });
      const repeat = await blocksPost(
        new NextRequest("http://localhost:3000/api/blocks", {
          method: "POST",
          body: JSON.stringify({ alias: "Ada" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(repeat.status).toBe(200);
      expect((await repeat.json()).created).toBe(false);
    });

    it("maps self_block and an unknown alias onto 409 and 404", async () => {
      createBlock.mockRejectedValueOnce(
        new ModerationError("self_block", "You cannot block yourself.", 409),
      );
      const self = await blocksPost(
        new NextRequest("http://localhost:3000/api/blocks", {
          method: "POST",
          body: JSON.stringify({ alias: "Ada" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(self.status).toBe(409);
      expect((await self.json()).error.code).toBe("self_block");

      createBlock.mockRejectedValueOnce(
        new ModerationError("not_found", "Nobody.", 404),
      );
      const missing = await blocksPost(
        new NextRequest("http://localhost:3000/api/blocks", {
          method: "POST",
          body: JSON.stringify({ alias: "Ghost" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(missing.status).toBe(404);
      expect((await missing.json()).error.code).toBe("not_found");
    });
  });
});
