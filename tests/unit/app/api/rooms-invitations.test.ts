import { GET, POST } from "@/app/api/rooms/[id]/invitations/route";
import { DELETE as revokeDelete } from "@/app/api/rooms/[id]/invitations/[invitationId]/route";
import { InvitationError } from "@/lib/invitations/queries";
import { RoomAccessError, RoomOwnerError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  requireRoomOwner,
  createInvitation,
  listRoomInvitations,
  revokeInvitation,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  requireRoomOwner: vi.fn(),
  createInvitation: vi.fn(),
  listRoomInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomOwner,
}));

vi.mock("@/lib/invitations/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invitations/queries")>()),
  createInvitation,
  listRoomInvitations,
  revokeInvitation,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";

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

function post(body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/invitations`, {
      method: "POST",
      body,
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

function list(id: string = ROOM_ID) {
  return {
    request: new NextRequest(`http://localhost:3000/api/rooms/${id}/invitations`),
    context: { params: Promise.resolve({ id }) },
  };
}

function revoke(id: string = ROOM_ID, invitationId: string = INVITATION_ID) {
  return {
    request: new NextRequest(
      `http://localhost:3000/api/rooms/${id}/invitations/${invitationId}`,
      { method: "DELETE" },
    ),
    context: { params: Promise.resolve({ id, invitationId }) },
  };
}

describe("invitations routes", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    requireRoomOwner.mockResolvedValue(undefined);
    createInvitation.mockResolvedValue(INVITATION);
    listRoomInvitations.mockResolvedValue([INVITATION]);
    revokeInvitation.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("POST create", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getClaims.mockResolvedValue({ data: null });
      const { request, context } = post(JSON.stringify({ invitee_alias: "buddy" }));

      const response = await POST(request, context);

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("unauthenticated");
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it("rejects a room id that is not a UUID", async () => {
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "buddy" }),
        "not-a-uuid",
      );

      const response = await POST(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it("rejects a body that is not JSON", async () => {
      const { request, context } = post("{not json");

      const response = await POST(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_json");
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it("rejects a missing alias", async () => {
      const { request, context } = post(JSON.stringify({}));

      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("validation");
      expect(body.error.issues).toEqual([
        { path: "invitee_alias", message: expect.any(String) },
      ]);
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it("refuses an invited user id instead of ignoring it", async () => {
      // Addressed invitations resolve the invitee from the alias inside the
      // RPC; a supplied id must fail loudly, never look honoured.
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "buddy", invitee_id: "someone" }),
      );

      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("validation");
      // Zod reports the unexpected key at the object root; the message names
      // the field, so the response still says exactly what was refused.
      expect(body.error.issues).toEqual([
        { path: "", message: expect.stringContaining("invitee_id") },
      ]);
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it("rejects a TTL outside 1–168 hours", async () => {
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "buddy", ttl_hours: 1000 }),
      );

      const response = await POST(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it("answers 201 with the invitation", async () => {
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "studybuddy", ttl_hours: 24 }),
      );

      const response = await POST(request, context);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ invitation: INVITATION });
      expect(createInvitation).toHaveBeenCalledWith(
        expect.anything(),
        ROOM_ID,
        "studybuddy",
        24,
      );
    });

    it("maps a missing alias to 404 invitee_not_found", async () => {
      createInvitation.mockRejectedValue(
        new InvitationError(
          "invitee_not_found",
          "No student studies under that alias.",
          404,
        ),
      );
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "ghost" }),
      );

      const response = await POST(request, context);

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("invitee_not_found");
    });

    it.each([
      ["already_invited", 409],
      ["already_member", 409],
      ["room_public", 409],
      ["self_invite", 409],
      ["not_owner", 403],
    ])("maps %s to %d", async (code, status) => {
      createInvitation.mockRejectedValue(
        new InvitationError(code as InvitationError["code"], "boom", status as 409),
      );
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "studybuddy" }),
      );

      const response = await POST(request, context);

      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    });

    it("returns 500 without leaking the failure detail", async () => {
      createInvitation.mockRejectedValue(
        new Error('relation "public.room_invitations" is locked'),
      );
      const { request, context } = post(
        JSON.stringify({ invitee_alias: "studybuddy" }),
      );

      const response = await POST(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("invitation_create_failed");
      expect(JSON.stringify(body)).not.toContain("room_invitations");
    });
  });

  describe("GET list", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getClaims.mockResolvedValue({ data: null });
      const { request, context } = list();

      const response = await GET(request, context);

      expect(response.status).toBe(401);
      expect(listRoomInvitations).not.toHaveBeenCalled();
    });

    it("answers 200 with the owner's invitations", async () => {
      const { request, context } = list();

      const response = await GET(request, context);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ invitations: [INVITATION] });
      expect(requireRoomOwner).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    });

    it("maps a non-member to 404 and a non-owner member to 403", async () => {
      requireRoomOwner.mockRejectedValueOnce(
        new RoomAccessError("That room does not exist or is not available."),
      );
      const nonMember = list();
      const first = await GET(nonMember.request, nonMember.context);
      expect(first.status).toBe(404);
      expect((await first.json()).error.code).toBe("not_found");

      requireRoomOwner.mockRejectedValueOnce(new RoomOwnerError("nope"));
      const member = list();
      const second = await GET(member.request, member.context);
      expect(second.status).toBe(403);
      expect((await second.json()).error.code).toBe("not_owner");
    });

    it("returns 500 when the list fails", async () => {
      listRoomInvitations.mockRejectedValue(new Error("boom"));
      const { request, context } = list();

      const response = await GET(request, context);

      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("invitations_failed");
    });
  });

  describe("DELETE revoke", () => {
    it("rejects unauthenticated requests with 401", async () => {
      getClaims.mockResolvedValue({ data: null });
      const { request, context } = revoke();

      const response = await revokeDelete(request, context);

      expect(response.status).toBe(401);
      expect(revokeInvitation).not.toHaveBeenCalled();
    });

    it("rejects a malformed invitation id with 400", async () => {
      const { request, context } = revoke(ROOM_ID, "not-a-uuid");

      const response = await revokeDelete(request, context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
      expect(revokeInvitation).not.toHaveBeenCalled();
    });

    it("answers 200 { revoked: true }", async () => {
      const { request, context } = revoke();

      const response = await revokeDelete(request, context);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revoked: true });
      expect(revokeInvitation).toHaveBeenCalledWith(
        expect.anything(),
        INVITATION_ID,
      );
    });

    it("maps an invisible or already-resolved invitation to 404", async () => {
      revokeInvitation.mockRejectedValue(
        new InvitationError(
          "not_found",
          "That invitation does not exist or is not available.",
          404,
        ),
      );
      const { request, context } = revoke();

      const response = await revokeDelete(request, context);

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("not_found");
    });

    it("maps a member who is not the owner to 403", async () => {
      requireRoomOwner.mockRejectedValue(new RoomOwnerError("nope"));
      const { request, context } = revoke();

      const response = await revokeDelete(request, context);

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("not_owner");
      expect(revokeInvitation).not.toHaveBeenCalled();
    });

    it("returns 500 without leaking the failure detail", async () => {
      revokeInvitation.mockRejectedValue(
        new Error('relation "public.room_invitations" is locked'),
      );
      const { request, context } = revoke();

      const response = await revokeDelete(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("invitation_revoke_failed");
      expect(JSON.stringify(body)).not.toContain("room_invitations");
    });
  });
});
