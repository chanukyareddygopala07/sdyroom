import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, readJsonBody, validationResponse } from "@/lib/api/responses";
import {
  NotificationQueryError,
  updateNotificationPrefs,
} from "@/lib/notifications/queries";
import { updateNotificationPrefsSchema } from "@/lib/notifications/validation";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/profile/notification-prefs — partial update of the caller's
 * per-category preferences. Body: `{ "prefs": { "invite": "none", ... } }`
 * with every key optional and every value from the closed enum; unknown keys
 * are a 400 naming the field, and the update is merged over the stored
 * record so an untouched category stays untouched. The profile row is the
 * caller's own (`profiles_update_own` + the 0012 column grant), and the
 * writer RPCs re-read this column at write time — a change here binds the
 * very next notification, with nothing to cache or invalidate.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "prefs": { "default": "all", "invite": "all", "moderation": "all", "ai": "all", "resource": "all" } }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "notifications_failed" } }` |
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to update preferences.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = updateNotificationPrefsSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    const prefs = await updateNotificationPrefs(
      supabase,
      data.claims.sub,
      parsed.data.prefs,
    );
    return NextResponse.json({ prefs });
  } catch (error) {
    if (error instanceof NotificationQueryError) {
      console.error("[api/profile/notification-prefs] failed:", error);
      return errorResponse(
        "notifications_failed",
        "Preferences could not be saved. Please try again.",
        500,
      );
    }
    throw error;
  }
}
