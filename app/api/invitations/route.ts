import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { listMyInvitations } from "@/lib/invitations/queries";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/invitations — the caller's invitation inbox, newest first.
 *
 * Policy `room_invitations_select_addressed` already restricts rows to those
 * where the caller is invitee or inviter; this query additionally filters
 * `invitee_id = auth.uid()` so the invitee view can never include the
 * caller's own outgoing invitations. Responses carry only alias/addressed
 * columns — no user ids, and never a token, because addressed invitations
 * have no token. Expiry is derived (`expired`), matching the database's
 * read-time evaluation: a pending row past its deadline is reported expired
 * here and answers 410 on accept.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "invitations": [{ id, room_id, room_name, inviter_alias, invitee_alias, status, created_at, expires_at, resolved_at, expired }] }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "invitations_failed" } }` |
 */
export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims || !data.claims.sub) {
    return errorResponse("unauthenticated", "Sign in to view invitations.", 401);
  }

  try {
    const invitations = await listMyInvitations(supabase, data.claims.sub);
    return NextResponse.json({ invitations });
  } catch (error) {
    console.error("[api/invitations] list failed:", error);
    return errorResponse(
      "invitations_failed",
      "Invitations could not be loaded.",
      500,
    );
  }
}
