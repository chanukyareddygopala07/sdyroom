import { NextResponse, type NextRequest } from "next/server";

import { emptyBodyResponse, errorResponse, readEmptyBody } from "@/lib/api/responses";
import {
  markAllNotificationsRead,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/notifications/read-all — mark every unread row the caller owns
 * read, in one statement. The row filter is `read_at is null` under the
 * own-row RLS policy, so "somebody else's items" is not a state this
 * endpoint can reach: it updates exactly the rows the same caller could
 * have listed. Bodyless; the count returned is rows actually touched, so a
 * second call reports `{ updated: 0 }` rather than a stale number.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "updated": 3 }` |
 * | 400 | `{ "error": { "code": "invalid_request" } }` — a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "notifications_failed" } }` |
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to update notifications.", 401);
  }

  const body = await readEmptyBody(request);
  const emptyBodyError = emptyBodyResponse(body);
  if (emptyBodyError) {
    return emptyBodyError;
  }

  try {
    const result = await markAllNotificationsRead(supabase);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NotificationQueryError) {
      console.error("[api/notifications/read-all] failed:", error);
      return errorResponse(
        "notifications_failed",
        "Notifications could not be updated.",
        500,
      );
    }
    throw error;
  }
}
