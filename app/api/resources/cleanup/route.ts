import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { cleanupSpec } from "@/lib/rate-limit/keys";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import { ResourceError } from "@/lib/resources/queries";
import { RESOURCE_BUCKET } from "@/lib/resources/types";
import { createClient } from "@/lib/supabase/server";
import { resourceCleanupSchema } from "@/lib/validation/resources";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * An object or a row younger than this is treated as an upload that is still
 * in flight (the object is written before the row) and is never swept. It is
 * also what keeps two concurrent sweeps from racing an honest request.
 */
export const SWEEP_GRACE_MS = 60_000;

/** Safety valve: a sweep reads storage in pages of this size. */
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 100;

type SweepCounts = { removed_objects: number; removed_rows: number };

function cleanupFailed(): never {
  throw new ResourceError(
    "cleanup_failed",
    "The cleanup could not finish. Please try again.",
    500,
  );
}

function ageOk(createdAt: string | null | undefined): boolean {
  const stamp = Date.parse(createdAt ?? "");
  if (Number.isNaN(stamp)) {
    // Unknown age: never delete what we cannot date. A sweep that skips a
    // few odd entries is strictly better than one that eats a live upload.
    return false;
  }
  return Date.now() - stamp >= SWEEP_GRACE_MS;
}

/**
 * Lists every file directly under `prefix` (the caller's own folder), paging
 * until storage runs out of entries. A list failure aborts the whole sweep:
 * without a complete view of the folder, "not listed" would be a lie and the
 * row half of the sweep could delete live rows.
 */
async function listObjectPaths(
  client: SupabaseClient,
  prefix: string,
): Promise<Map<string, string | null>> {
  const bucket = client.storage.from(RESOURCE_BUCKET);
  const paths = new Map<string, string | null>();

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { data, error } = await bucket.list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset: page * LIST_PAGE_SIZE,
    });
    if (error) {
      console.error("[api/resources/cleanup] list failed:", error.message);
      cleanupFailed();
    }

    const entries = data ?? [];
    for (const entry of entries) {
      // `id === null` marks a folder in the Storage API; the key layout has
      // no deeper files, so folders are skipped rather than descended into.
      if (entry.id !== null) {
        paths.set(`${prefix}/${entry.name}`, entry.created_at ?? null);
      }
    }

    if (entries.length < LIST_PAGE_SIZE) {
      return paths;
    }
  }
  return paths;
}

/**
 * POST /api/resources/cleanup — sweep one scope for orphaned bytes.
 *
 * Two failure directions exist in this system and this route repairs both:
 *
 *  - **Object with no row** — a crashed upload, or a row insert that failed
 *    after the object landed. The object is unreachable forever (the bucket
 *    is private and nothing signs a URL without a row), so it is deleted.
 *  - **Row with no object** — the object was removed out of band. The row
 *    advertises a download that can never succeed, so the row is deleted.
 *
 * Scope follows `GET /api/resources`: no body sweeps the caller's personal
 * folder (`personal/{caller}/**`), `{ "room_id": … }` sweeps their uploads
 * inside that room (`rooms/{room}/{caller}/**`). Both sides of the comparison
 * are restricted to the caller's own key prefix, so a sweep can only ever
 * touch files the caller uploaded — a member sweeping a room cleans their
 * own contributions, and the storage DELETE policy (`owner = auth.uid()`)
 * enforces the same boundary independently. SQL cannot call the Storage API,
 * which is why the comparison lives here rather than in the migration.
 *
 * Anything younger than `SWEEP_GRACE_MS` is skipped in both directions, so
 * an upload that is mid-flight (object written, row not yet inserted) is
 * never mistaken for an orphan.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "removed_objects": n, "removed_rows": n, "scope": "personal"\|"room", "room_id": uuid\|null }` |
 * | 400 | `{ "error": { "code": "invalid_json" \| "invalid_request" \| "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — `room_id` names a missing room or one the caller is not a member of |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "cleanup_failed" } }` |
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to run a cleanup.", 401);
  }

  const limited = await rateLimitedResponse(
    supabase,
    cleanupSpec(claims.sub),
    "Cleanup was requested too often — wait about a minute and try again.",
  );
  if (limited) {
    return limited;
  }

  const raw = await request.text().catch(() => null);
  if (raw === null) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  let json: unknown = {};
  if (raw.trim() !== "") {
    try {
      json = JSON.parse(raw);
    } catch {
      return errorResponse("invalid_json", "The request body must be JSON.", 400);
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      return errorResponse(
        "invalid_request",
        "The request body must be a JSON object.",
        400,
      );
    }
  }

  const parsed = resourceCleanupSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      "validation",
      "Check the highlighted fields and try again.",
      400,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  const roomId = parsed.data.room_id ?? null;

  try {
    if (roomId !== null) {
      await requireRoomMembership(supabase, roomId);
    }

    const counts = await sweepOwnScope(supabase, claims.sub, roomId);

    return NextResponse.json({
      ...counts,
      scope: roomId === null ? "personal" : "room",
      room_id: roomId,
    });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof ResourceError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error("[api/resources/cleanup] sweep failed:", error);
    return errorResponse(
      "cleanup_failed",
      "The cleanup could not finish. Please try again.",
      500,
    );
  }
}

async function sweepOwnScope(
  supabase: SupabaseClient,
  userId: string,
  roomId: string | null,
): Promise<SweepCounts> {
  const prefix =
    roomId === null ? `personal/${userId}` : `rooms/${roomId}/${userId}`;
  const pathPattern = `${prefix}/%`;

  // Rows: filtered by the server-built key prefix (the layout CHECK makes
  // this exact — a prefix can only match this caller's own uploads in this
  // scope) rather than by `owner_id`, which carries no SELECT grant.
  const { data: rows, error: rowError } = await supabase
    .from("study_resources")
    .select("id, storage_path, created_at")
    .like("storage_path", pathPattern);

  if (rowError) {
    console.error("[api/resources/cleanup] row list failed:", rowError.message);
    cleanupFailed();
  }

  const objects = await listObjectPaths(supabase, prefix);

  // Direction 1: an object no row points at, past the grace period.
  const rowPaths = new Set((rows ?? []).map((row) => row.storage_path));
  const orphanPaths = [...objects.keys()].filter(
    (path) => !rowPaths.has(path) && ageOk(objects.get(path)),
  );

  if (orphanPaths.length > 0) {
    const bucket = supabase.storage.from(RESOURCE_BUCKET);
    for (let i = 0; i < orphanPaths.length; i += 100) {
      const chunk = orphanPaths.slice(i, i + 100);
      const { error } = await bucket.remove(chunk);
      if (error) {
        console.error(
          "[api/resources/cleanup] object remove failed:",
          chunk.length,
          "keys,",
          error.message,
        );
        cleanupFailed();
      }
    }
  }

  // Direction 2: a row whose object is gone, past the grace period. Compared
  // against *every* listed object, not just the deletable ones.
  const brokenIds = (rows ?? [])
    .filter(
      (row) => !objects.has(row.storage_path) && ageOk(row.created_at),
    )
    .map((row) => row.id);

  let removedRows = 0;
  if (brokenIds.length > 0) {
    const { data: deleted, error: deleteError } = await supabase
      .from("study_resources")
      .delete()
      .in("id", brokenIds)
      .select("id");

    if (deleteError) {
      console.error("[api/resources/cleanup] row delete failed:", deleteError.message);
      cleanupFailed();
    }
    removedRows = (deleted ?? []).length;
  }

  return { removed_objects: orphanPaths.length, removed_rows: removedRows };
}
