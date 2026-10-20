import { NextResponse, type NextRequest } from "next/server";
import {
  emptyBodyResponse,
  errorResponse,
  readEmptyBody,
} from "@/lib/api/responses";
import { createMeetingToken } from "@/lib/meeting/token";
import { getMeetingConfig } from "@/lib/meeting/config";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { meetingTokenSpec } from "@/lib/rate-limit/keys";
import { ModerationError } from "@/lib/moderation/errors";
import { getRoomModerationInfo } from "@/lib/moderation/queries";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError, logWarn } from "@/lib/server/log";

type TokenContext = { params: Promise<{ id: string }> };

/**
 * POST /api/rooms/[id]/meeting/token — mint a short-lived LiveKit join token
 * for the signed-in member of exactly this room.
 *
 * Authorization is decided entirely on this request: the session supplies the
 * user id (the token's participant identity), the room id comes from the path
 * and is validated as a UUID, and `requireRoomMembership` proves membership
 * under RLS — so a missing room, a private room you are not in, and a room
 * you have been removed from all answer the same `404 not_found`. Nothing in
 * the request body is trusted (the endpoint takes an empty body on purpose).
 *
 * An active room mute maps into the token grants: the microphone is dropped
 * from `canPublishSources`, so a muted student joins, watches, shares screen
 * and uses chat, but cannot publish audio until the mute lifts and they
 * rejoin. Owners and moderators are exempt from mutes by the existing
 * moderation rules, and moderation actions themselves stay on their existing
 * server-authorized routes.
 *
 * The signing secret stays server-side: the response carries only the signed
 * token, the endpoint URL and grant-relevant facts. Tokens are never logged
 * (`lib/server/log.ts` redacts `token`/`jwt` keys and JWT-shaped values).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "token": "…", "url": "wss://…", "room": "sdyroom-<uuid>", "identity": "<user id>", "expires_in": 600, "can_publish_mic": true }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing or private room, or you are no longer a member |
 * | 429 | `{ "error": { "code": "rate_limited" } }` with `Retry-After` |
 * | 503 | `{ "error": { "code": "meeting_unavailable" } }` — LiveKit is not configured on this server |
 * | 500 | `{ "error": { "code": "meeting_token_failed" } }` |
 *
 * The 503 is honest, not a fallback: when no provider is configured the room
 * workspace hides the join control altogether, and this answer exists for a
 * config change between page load and request.
 */
async function POST_raw(request: NextRequest, { params }: TokenContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to join this meeting.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const bodyResponse = emptyBodyResponse(await readEmptyBody(request));
  if (bodyResponse) return bodyResponse;

  // Provider availability before anything is spent on the request: an
  // unconfigured deployment answers honestly instead of minting nothing
  // against a consumed rate-limit slot.
  const config = getMeetingConfig();
  if (!config) {
    logWarn("[api/rooms/meeting/token] live meetings are not configured");
    return errorResponse(
      "meeting_unavailable",
      "Live meetings are not configured on this server.",
      503,
    );
  }

  const limited = await rateLimitedResponse(
    supabase,
    meetingTokenSpec(parsedRoomId.data, claims.sub),
    "Too many join attempts — wait a moment and try again.",
  );
  if (limited) return limited;

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const moderation = await getRoomModerationInfo(supabase, parsedRoomId.data);
    const mutedUntil = moderation.muted_until
      ? Date.parse(moderation.muted_until)
      : Number.NaN;
    const silenced =
      moderation.viewer_is_muted &&
      (Number.isNaN(mutedUntil) || mutedUntil > Date.now());

    // Display name only, read from the caller's own profile row (RLS-scoped,
    // same lookup `POST …/messages` does). The token identity stays the
    // opaque session id above.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("alias")
      .eq("id", claims.sub)
      .maybeSingle();
    if (profileError || !profile || typeof profile.alias !== "string") {
      throw new Error(
        `alias lookup failed: ${profileError?.message ?? "profile not found"}`,
      );
    }

    const result = await createMeetingToken(config, {
      roomId: parsedRoomId.data,
      userId: claims.sub,
      alias: profile.alias,
      silenced,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/rooms/meeting/token] failed:", errorFields(error));
    return errorResponse(
      "meeting_token_failed",
      "The meeting could not be started. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
