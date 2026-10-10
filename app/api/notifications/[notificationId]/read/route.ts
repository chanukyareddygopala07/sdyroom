import { NextResponse, type NextRequest } from "next/server";

import { emptyBodyResponse, errorResponse, readEmptyBody } from "@/lib/api/responses";
import {
  markNotificationRead,
  NotificationNotFoundError,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { notificationIdSchema } from "@/lib/notifications/validation";
import { createClient } from "@/lib/supabase/server";

type ReadContext = { params: Promise<{ notificationId: string }> };

/**
 * POST /api/notifications/[notificationId]/read — mark one of the caller's
 * notifications read. Bodyless; identity comes from the session and the row
 * from the path. Idempotent by contract: a row that is already read answers
 * `200 { read: true, unchanged: true }`, and a foreign or missing id is the
 * same `404` — RLS filters other users' rows exactly like nonexistent ones,
 * so the endpoint is not an existence oracle. No rate limit: the write is
 * one indexed update against the caller's own rows.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "read": true, "unchanged": false \| true }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_request" } }` — bad id or a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "notifications_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: ReadContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to update notifications.", 401);
  }

  const { notificationId } = await params;
  const parsedId = notificationIdSchema.safeParse(notificationId);
  if (!parsedId.success) {
    return errorResponse("validation", "That notification id is not valid.", 400, [
      { path: "notificationId", message: "Notification id must be a UUID." },
    ]);
  }

  const body = await readEmptyBody(request);
  const emptyBodyError = emptyBodyResponse(body);
  if (emptyBodyError) {
    return emptyBodyError;
  }

  try {
    const result = await markNotificationRead(supabase, parsedId.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NotificationNotFoundError) {
      return errorResponse(
        "not_found",
        "That notification does not exist.",
        404,
      );
    }
    if (error instanceof NotificationQueryError) {
      console.error("[api/notifications/read] failed:", error);
      return errorResponse(
        "notifications_failed",
        "That notification could not be updated.",
        500,
      );
    }
    throw error;
  }
}
