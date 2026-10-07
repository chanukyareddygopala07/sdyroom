import { GET } from "@/app/api/invitations/route";
import { POST as acceptPost } from "@/app/api/invitations/[id]/accept/route";
import { POST as rejectPost } from "@/app/api/invitations/[id]/reject/route";
import { InvitationError } from "@/lib/invitations/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  listMyInvitations,
  acceptInvitation,
  rejectInvitation,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  listMyInvitations: vi.fn(),
  acceptInvitation: vi.fn(),
  rejectInvitation: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/invitations/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invitations/queries")>()),
  listMyInvitations,
  acceptInvitation,
  rejectInvitation,
}));

const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const INVITATION = {
  id: INVITATION_ID,
  room_id: ROOM_ID,
  room_name: "Quiet Hall",
  inviter_alias: "owneralias",
  invitee_alias: "studybuddy",
  status: "pending",
  created_at: "2026-10-07T10:00:00.000Z",
  expires_at: "2026-10-14T10:00:00.000Z",
  resolved_at: null,
  expired: false,
};

function respond(
  handler: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>,
  action: "accept" | "reject",
  opts: { id?: string; body?: string } = {},
) {
  const id = opts.id ?? INVITATION_ID;
  return {
    request: new NextRequest(
      `http://localhost:3000/api/invitations/${id}/${action}`,
      {
        method: "POST",
        body: opts.body,
        headers:
          opts.body === undefined
            ? {}
            : { "content-type": "application/json" },
      },
    ),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("invitation inbox and responses", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    listMyInvitations.mockResolvedValue([INVITATION]);
    acceptInvitation.mockResolvedValue({
      membership: "joined",
      room_id: ROOM_ID,
      room_name: "Quiet Hall",
      member_count: 3,
    });
    rejectInvitation.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("GET /api/invitations", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getClaims.mockResolvedValue({ data: null });

      const response = await GET();

      expect(response.status).toBe(401);
      expect(listMyInvitations).not.toHaveBeenCalled();
    });

    it("answers 200 with the caller's addressed invitations", async () => {
      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ invitations: [INVITATION] });
      expect(listMyInvitations).toHaveBeenCalledWith(expect.anything(), "user-1");
    });

    it("returns 500 without leaking the failure detail", async () => {
      listMyInvitations.mockRejectedValue(
        new Error('permission denied for table room_invitations'),
      );

      const response = await GET();

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("invitations_failed");
      expect(JSON.stringify(body)).not.toContain("room_invitations");
    });
  });

  describe("POST accept", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getClaims.mockResolvedValue({ data: null });
      const { request, context } = respond(acceptPost, "accept");

      const response = await acceptPost(request, context);

      expect(response.status).toBe(401);
      expect(acceptInvitation).not.toHaveBeenCalled();
    });

    it("rejects an id that is not a UUID", async () => {
      const { request, context } = respond(acceptPost, "accept", {
        id: "not-a-uuid",
      });

      const response = await acceptPost(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
      expect(acceptInvitation).not.toHaveBeenCalled();
    });

    it("refuses identity supplied in the body instead of ignoring it", async () => {
      const { request, context } = respond(acceptPost, "accept", {
        body: JSON.stringify({ user_id: "someone" }),
      });

      const response = await acceptPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.issues).toEqual([
        { path: "user_id", message: "Not accepted here." },
      ]);
      expect(acceptInvitation).not.toHaveBeenCalled();
    });

    it("accepts an absent body and an empty object", async () => {
      for (const body of [undefined, "{}"]) {
        const { request, context } = respond(acceptPost, "accept", { body });
        const response = await acceptPost(request, context);
        expect(response.status).toBe(201);
        expect(acceptInvitation).toHaveBeenCalledWith(
          expect.anything(),
          INVITATION_ID,
        );
      }
    });

    it("answers 201 with the room for a first-time accept", async () => {
      const { request, context } = respond(acceptPost, "accept");

      const response = await acceptPost(request, context);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        membership: "joined",
        room_id: ROOM_ID,
        room_name: "Quiet Hall",
        member_count: 3,
      });
    });

    it("answers 200 for an idempotent repeat that found an existing seat", async () => {
      acceptInvitation.mockResolvedValue({
        membership: "already_member",
        room_id: ROOM_ID,
        room_name: "Quiet Hall",
        member_count: 3,
      });
      const { request, context } = respond(acceptPost, "accept");

      const response = await acceptPost(request, context);

      expect(response.status).toBe(200);
      expect((await response.json()).membership).toBe("already_member");
    });

    it.each([
      ["not_found", 404],
      ["used", 409],
      ["rejected", 409],
      ["revoked", 409],
      ["room_full", 409],
      ["room_closed", 409],
      ["expired", 410],
    ])("maps %s to %d", async (code, status) => {
      acceptInvitation.mockRejectedValue(
        new InvitationError(
          code as InvitationError["code"],
          "boom",
          status as 404,
        ),
      );
      const { request, context } = respond(acceptPost, "accept");

      const response = await acceptPost(request, context);

      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    });

    it("returns 500 without leaking the failure detail", async () => {
      acceptInvitation.mockRejectedValue(
        new Error('relation "public.room_invitations" is locked'),
      );
      const { request, context } = respond(acceptPost, "accept");

      const response = await acceptPost(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("invitation_accept_failed");
      expect(JSON.stringify(body)).not.toContain("room_invitations");
    });
  });

  describe("POST reject", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getClaims.mockResolvedValue({ data: null });
      const { request, context } = respond(rejectPost, "reject");

      const response = await rejectPost(request, context);

      expect(response.status).toBe(401);
      expect(rejectInvitation).not.toHaveBeenCalled();
    });

    it("answers 200 { rejected: true } for an empty body", async () => {
      const { request, context } = respond(rejectPost, "reject");

      const response = await rejectPost(request, context);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ rejected: true });
      expect(rejectInvitation).toHaveBeenCalledWith(
        expect.anything(),
        INVITATION_ID,
      );
    });

    it("refuses a body with fields", async () => {
      const { request, context } = respond(rejectPost, "reject", {
        body: JSON.stringify({ note: "no thanks" }),
      });

      const response = await rejectPost(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
      expect(rejectInvitation).not.toHaveBeenCalled();
    });

    it.each([
      ["not_found", 404],
      ["used", 409],
      ["rejected", 409],
      ["expired", 410],
    ])("maps %s to %d", async (code, status) => {
      rejectInvitation.mockRejectedValue(
        new InvitationError(
          code as InvitationError["code"],
          "boom",
          status as 404,
        ),
      );
      const { request, context } = respond(rejectPost, "reject");

      const response = await rejectPost(request, context);

      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    });

    it("returns 500 without leaking the failure detail", async () => {
      rejectInvitation.mockRejectedValue(
        new Error('relation "public.room_invitations" is locked'),
      );
      const { request, context } = respond(rejectPost, "reject");

      const response = await rejectPost(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("invitation_reject_failed");
      expect(JSON.stringify(body)).not.toContain("room_invitations");
    });
  });
});
