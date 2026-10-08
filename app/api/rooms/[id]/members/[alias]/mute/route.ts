import { NextResponse, type NextRequest } from "next/server";
import { emptyBodyResponse, errorResponse, readEmptyBody, readJsonBody, validationResponse } from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { muteSpec } from "@/lib/rate-limit/keys";
import { ModerationError } from "@/lib/moderation/errors";
import { muteMember, unmuteMember } from "@/lib/moderation/queries";
import {
  requireRoomMembership,
  RoomAccessError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { memberAliasSchema, muteBodySchema } from "@/lib/validation/moderation";
import { roomIdSchema } from "@/lib/validation/rooms";

type MuteContext = {
  params: Promise<{ id: string; alias: string }>;
};

/**
 * Mute state lives in `room_mutes` (RLS own-row readable, no public writes);
 * the write path is the SECURITY DEFINER RPCs only. A mute denies the
 * target's message INSERT through a clause on the existing `room_messages`
 * INSERT policy — enforced server-side at the database, with no client
 * cooperation — while their history reads and the room's other APIs keep
 * working. Owners and moderators cannot be muted; nobody mutes themselves.
 *
 * Responses (POST takes `{ "duration": "1h" | "24h" | "7d" }`):
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "unmuted": true }` |
 * | 201 | `{ "muted": true, "muted_until": string, "duration": string }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_json" } \| { "code": "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_moderator" } \| { "code": "cannot_mute_owner" } \| { "code": "cannot_mute_moderator" } \| { "code": "cannot_mute_self" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room, non-member, unknown alias, or caller lacks rights |
 * | 409 | `{ "error": { "code": "already_muted" } \| { "code": "not_muted" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "moderation_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: MuteContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to manage mutes.", 401);
  }

  const { id, alias } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const limited = await rateLimitedResponse(
    supabase,
    muteSpec(parsedRoomId.data, data.claims.sub),
    "Too many mute changes — wait a while and try again.",
  );
  if (limited) {
    return limited;
  }

  const parsedAlias = memberAliasSchema.safeParse(alias);
  if (!parsedAlias.success) {
    return errorResponse("validation", "That alias is not valid.", 400, [
      { path: "alias", message: "Alias must be 1–32 characters." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsedMute = muteBodySchema.safeParse(parsedBody.body);
  if (!parsedMute.success) {
    return validationResponse(parsedMute.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const result = await muteMember(
      supabase,
      parsedRoomId.data,
      parsedAlias.data,
      parsedMute.data.duration,
    );
    return NextResponse.json(
      {
        muted: true,
        muted_until: result.muted_until,
        duration: parsedMute.data.duration,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomAccessError) {
      return errorResponse(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }

    console.error("[api/rooms/members/mute] failed:", error);
    return errorResponse(
      "moderation_failed",
      "That member could not be muted. Please try again.",
      500,
    );
  }
}

/**
 * DELETE /api/rooms/[id]/members/[alias]/mute — lift an active mute.
 * Bodyless; every status in the POST table applies, with 409 `not_muted`
 * when no active mute exists.
 */
export async function DELETE(request: NextRequest, { params }: MuteContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to manage mutes.", 401);
  }

  const { id, alias } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const limited = await rateLimitedResponse(
    supabase,
    muteSpec(parsedRoomId.data, data.claims.sub),
    "Too many mute changes — wait a while and try again.",
  );
  if (limited) {
    return limited;
  }

  const parsedAlias = memberAliasSchema.safeParse(alias);
  if (!parsedAlias.success) {
    return errorResponse("validation", "That alias is not valid.", 400, [
      { path: "alias", message: "Alias must be 1–32 characters." },
    ]);
  }

  const body = await readEmptyBody(request);
  const emptyBodyError = emptyBodyResponse(body);
  if (emptyBodyError) {
    return emptyBodyError;
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    await unmuteMember(supabase, parsedRoomId.data, parsedAlias.data);
    return NextResponse.json({ unmuted: true });
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomAccessError) {
      return errorResponse(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }

    console.error("[api/rooms/members/unmute] failed:", error);
    return errorResponse(
      "moderation_failed",
      "That member could not be unmuted. Please try again.",
      500,
    );
  }
}
