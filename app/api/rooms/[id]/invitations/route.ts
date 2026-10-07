import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import {
  createInvitation,
  InvitationError,
  listRoomInvitations,
} from "@/lib/invitations/queries";
import {
  requireRoomOwner,
  RoomAccessError,
  RoomOwnerError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { createInvitationSchema } from "@/lib/validation/invitations";
import { roomIdSchema } from "@/lib/validation/rooms";

type InvitationsContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/invitations — invite a student to a private room by
 * their SdyRoom alias.
 *
 * Identity comes from the session only: `inviter_id` is derived from
 * `auth.uid()` inside the RPC and the alias is resolved there too, so a
 * forged `invitee_id` in the body is a 400 that names the field rather than
 * an ignored suggestion. The caller must be the room's owner
 * (`requireRoomOwner`), and the RPC re-checks owner, privacy and every
 * invitation rule again — two layers, as everywhere else.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "invitation": { id, room_id, room_name, inviter_alias, invitee_alias, status, created_at, expires_at, resolved_at } }` — read once here; listings repeat it |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` — member, not owner |
 * | 404 | `{ "error": { "code": "not_found" \| "invitee_not_found" } }` — room: missing or private-from-outside; alias: no such student |
 * | 409 | `{ "error": { "code": "room_public" \| "self_invite" \| "already_member" \| "already_invited" } }` |
 * | 500 | `{ "error": { "code": "invitation_create_failed" } }` |
 *
 * A non-member gets 404 before the owner check runs, so the endpoint is not
 * an existence oracle for private rooms.
 */
export async function POST(request: NextRequest, { params }: InvitationsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to invite a student.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = createInvitationSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    await requireRoomOwner(supabase, parsedRoomId.data);

    const invitation = await createInvitation(
      supabase,
      parsedRoomId.data,
      parsed.data.invitee_alias,
      parsed.data.ttl_hours,
    );

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof RoomOwnerError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof InvitationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/invitations] create failed:", error);
    return errorResponse(
      "invitation_create_failed",
      "The invitation could not be created.",
      500,
    );
  }
}

/**
 * GET /api/rooms/[id]/invitations — the owner's list for one room, newest
 * first. RLS already narrows the rows to invitations the caller created;
 * the owner gate runs first so a plain member gets 403 rather than a
 * confusing empty list. Neither user-id column is projected, expired is
 * derived by the reader, and no listing ever contained a usable token —
 * there is no token in this design at all.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "invitations": [{ id, room_id, room_name, inviter_alias, invitee_alias, status, created_at, expires_at, resolved_at, expired }] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "invitations_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: InvitationsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view invitations.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  try {
    await requireRoomOwner(supabase, parsedRoomId.data);
    const invitations = await listRoomInvitations(supabase, parsedRoomId.data);
    return NextResponse.json({ invitations });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof RoomOwnerError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms/invitations] list failed:", error);
    return errorResponse(
      "invitations_failed",
      "Invitations could not be loaded.",
      500,
    );
  }
}
