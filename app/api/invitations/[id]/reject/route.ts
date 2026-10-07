import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import {
  InvitationError,
  rejectInvitation,
} from "@/lib/invitations/queries";
import { createClient } from "@/lib/supabase/server";
import { invitationIdSchema } from "@/lib/validation/invitations";

type RejectContext = { params: Promise<{ id: string }> };

/**
 * POST /api/invitations/[id]/reject — reject an invitation addressed to the
 * caller.
 *
 * Same single-argument, session-only shape as accept; the RPC flips a
 * pending row to rejected in place (kept as history, never auto-purged).
 * Rejection takes no seat and does not touch the room. A second reject after
 * the first is 409 `rejected`; an expired pending row is 410 and the caller
 * may dismiss it from the inbox instead.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "rejected": true }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` — id not a UUID, or a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing, not addressed to you, or revoked |
 * | 409 | `{ "error": { "code": "used" \| "rejected" } }` — already accepted or already rejected |
 * | 410 | `{ "error": { "code": "expired" } }` |
 * | 500 | `{ "error": { "code": "invitation_reject_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: RejectContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to reject an invitation.", 401);
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
    await rejectInvitation(supabase, parsedId.data);
    return NextResponse.json({ rejected: true });
  } catch (error) {
    if (error instanceof InvitationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/invitations/reject] failed:", error);
    return errorResponse(
      "invitation_reject_failed",
      "The invitation could not be rejected.",
      500,
    );
  }
}
