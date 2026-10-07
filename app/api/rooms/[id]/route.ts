import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { removeRoomStorageObjects } from "@/lib/resources/storage";
import { ResourceError } from "@/lib/resources/queries";
import {
  deleteRoom,
  RoomMutationError,
  updateRoom,
} from "@/lib/rooms/queries";
import {
  requireRoomOwner,
  RoomAccessError,
  RoomOwnerError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema, updateRoomSchema } from "@/lib/validation/rooms";

type RoomItemContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/rooms/[id] — owner-only edit of the mutable room fields.
 *
 * Partial updates: the strict schema carries only the keys the caller sent,
 * and `update_room` applies exactly those under the room row lock. Nothing
 * in the body is trusted for identity — `owner_id` is not an accepted key
 * (strict Zod) and could not be applied anyway (no UPDATE grant; the RPC
 * re-reads ownership from `auth.uid()`). `visibility`, `id`, `created_at` and
 * `updated_at` are likewise unaddressable: absent from the schema, absent
 * from the RPC's fixed SET list, and refused by the column grants.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "room": PublicRoom }` — the row as the database has it after the update |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` — `invalid_request` is the empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` — member, not owner |
 * | 404 | `{ "error": { "code": "not_found" } }` — non-member or missing room, identical for both |
 * | 409 | `{ "error": { "code": "capacity_below_membership" } }` — the floor refused the shrink |
 * | 500 | `{ "error": { "code": "room_update_failed" } }` |
 *
 * The owner gate runs before the RPC, so a plain member stops at 403 and a
 * non-member never learns whether the room exists.
 */
export async function PATCH(request: NextRequest, { params }: RoomItemContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to edit this room.", 401);
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

  const parsed = updateRoomSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  if (Object.keys(parsed.data).length === 0) {
    return errorResponse(
      "invalid_request",
      "Provide at least one field to update.",
      400,
    );
  }

  try {
    await requireRoomOwner(supabase, parsedRoomId.data);

    const room = await updateRoom(supabase, parsedRoomId.data, parsed.data);
    return NextResponse.json({ room });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof RoomOwnerError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomMutationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms] update failed:", error);
    return errorResponse(
      "room_update_failed",
      "The room could not be updated. Please try again.",
      500,
    );
  }
}

/**
 * DELETE /api/rooms/[id] — owner-only room removal, with storage first.
 *
 * Order of operations (the mirror of `DELETE /api/resources/:id`, and the
 * direction `docs/API_CONTRACTS.md` records as deliberate):
 *
 *   1. Owner gate (`requireRoomOwner`): non-member 404, member-non-owner 403.
 *   2. Sweep `rooms/{id}/**` out of the private bucket while the metadata
 *      rows still exist — the rows are what the storage policies (and the
 *      room-owner policy 0008 adds) authorize against.
 *   3. `delete_room`: one cascading row delete under the room row lock.
 *
 * Objects before rows, never the reverse: a leftover *row* would advertise
 * downloads that can never succeed, while a leftover *object* is unreachable
 * the instant its membership cascade lands — but we do not aim for that
 * outcome either, it is only the documented residual if step 2 partially
 * fails, in which case nothing has been deleted and a retry converges
 * (`remove` on an already-gone key succeeds).
 *
 * The window that cannot be closed from either side: an upload whose object
 * lands *after* step 2's listing but whose metadata row commits *before*
 * step 3 — the row cascades away and that object is orphaned in a private
 * bucket (no row, no membership, no URL). Storage is not transactional with
 * Postgres, so no ordering eliminates it; it is bounded by two adjacent
 * calls, and every other interleaving converges (an upload whose row insert
 * finds the room gone rolls its own object back, per the upload path).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "deleted": true }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_owner" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — non-member, missing, or already deleted |
 * | 500 | `{ "error": { "code": "cleanup_failed" } }` — storage sweep failed; the room is intact, retry converges |
 * | 500 | `{ "error": { "code": "delete_failed" } }` — the row delete failed after the sweep; retry converges |
 *
 * A repeat DELETE is 404: the memberships that authorize the gate are gone
 * with the room, so the second call looks exactly like any other missing
 * room.
 */
export async function DELETE(request: NextRequest, { params }: RoomItemContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to delete this room.", 401);
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

    // Objects first. Failure here leaves every row in place — the room is
    // untouched and a retry re-runs the same idempotent sweep.
    await removeRoomStorageObjects(supabase, parsedRoomId.data);

    await deleteRoom(supabase, parsedRoomId.data);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof RoomOwnerError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomMutationError) {
      // not_found (404) and not_owner (403) — including the race where a
      // concurrent delete finished between the gate and the RPC.
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof ResourceError) {
      // The sweep failed; nothing has been deleted. The error carries its
      // own code (cleanup_failed) and status.
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/rooms] delete failed:", error);
    return errorResponse(
      "delete_failed",
      "The room could not be deleted. Please try again.",
      500,
    );
  }
}
