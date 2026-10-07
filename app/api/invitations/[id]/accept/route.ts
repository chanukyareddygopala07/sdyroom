import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import {
  acceptInvitation,
  InvitationError,
} from "@/lib/invitations/queries";
import { createClient } from "@/lib/supabase/server";
import { invitationIdSchema } from "@/lib/validation/invitations";

type AcceptContext = { params: Promise<{ id: string }> };

/**
 * POST /api/invitations/[id]/accept — accept an invitation addressed to the
 * caller and take a seat.
 *
 * The body, if any, is ignored by design (`readEmptyBody`): identity comes
 * from the session, and the only argument is the invitation id in the path.
 * The whole decision happens in one RPC inside one transaction — status
 * gate (pending, not expired), capacity via the shared join core with the
 * private gate opened, then the flip to accepted. A stranger cannot even
 * read the row (one 404 for missing, someone else's, and nonexistent). No
 * email or code is accepted anywhere in this flow.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "membership": "joined", "room_id", "room_name", "member_count" }` |
 * | 200 | `{ "membership": "already_member", "room_id", "room_name", "member_count" }` — idempotent repeat; invitation still consumed |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` — id not a UUID, or a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing, not addressed to you, or already revoked (inaccessible) |
 * | 409 | `{ "error": { "code": "used" \| "rejected" \| "revoked" \| "room_full" \| "room_closed" \| "already_member" } }` |
 * | 410 | `{ "error": { "code": "expired" } }` — read-time deadline check |
 * | 500 | `{ "error": { "code": "invitation_accept_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: AcceptContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to accept an invitation.", 401);
  }

  const { id } = await params;
  const parsedId = invitationIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That invitation id is not valid.", 400, [
      { path: "id", message: "Invitation id must be a UUID." },
    ]);
  }

  const bodyResponse = emptyBodyResponse(await readEmptyBody(request));
  if (bodyResponse) {
    return bodyResponse;
  }

  try {
    const outcome = await acceptInvitation(supabase, parsedId.data);
    return NextResponse.json(
      {
        membership: outcome.membership,
        room_id: outcome.room_id,
        room_name: outcome.room_name,
        member_count: outcome.member_count,
      },
      { status: outcome.membership === "joined" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof InvitationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/invitations/accept] failed:", error);
    return errorResponse(
      "invitation_accept_failed",
      "The invitation could not be accepted.",
      500,
    );
  }
}
