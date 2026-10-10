import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/api/responses";
import {
  listNotifications,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { listNotificationsQuerySchema } from "@/lib/notifications/validation";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/notifications — the caller's own inbox, newest first.
 *
 * Query: `?limit=20&cursor=<opaque>&unread=true`. The cursor is the opaque
 * base64 keyset from `lib/notifications/validation.ts`; `unread=true` narrows
 * the page to unread rows. RLS already scopes every row to `auth.uid()`, and
 * the unread count rides the same response because the inbox page and the
 * bell both need it and neither should spend a second round trip.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ notifications: [{ id, type, room_id, payload: { title, body, href }, read_at, created_at }], has_more, next_cursor, total, unread_count }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "notifications_failed" } }` |
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view notifications.", 401);
  }

  const parsed = listNotificationsQuerySchema.safeParse({
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
    unread: request.nextUrl.searchParams.get("unread") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse("validation", "That notification query is not valid.", 400);
  }

  try {
    const result = await listNotifications(supabase, parsed.data);
    return NextResponse.json({
      notifications: result.notifications,
      has_more: result.hasMore,
      next_cursor: result.nextCursor,
      total: result.total,
      unread_count: result.unreadCount,
    });
  } catch (error) {
    if (error instanceof NotificationQueryError) {
      console.error("[api/notifications] list failed:", error);
      return errorResponse(
        "notifications_failed",
        "Notifications could not be loaded.",
        500,
      );
    }
    throw error;
  }
}
