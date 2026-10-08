import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  validationResponse,
} from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { uploadTargetSpec, uploadUserSpec } from "@/lib/rate-limit/keys";
import { requireRoomMembership, RoomAccessError } from "@/lib/rooms/access";
import {
  listResources,
  insertResource,
  ResourceError,
  QUOTA_EXCEEDED_MESSAGE,
} from "@/lib/resources/queries";
import { fetchResourceQuota, resourceQuotaOk } from "@/lib/resources/quota";
import { buildStoragePath, uploadResourceObject, removeResourceObject } from "@/lib/resources/storage";
import { parseUploadForm } from "@/lib/resources/upload";
import { createClient } from "@/lib/supabase/server";
import { resourceListQuerySchema } from "@/lib/validation/resources";
import { MAX_FILE_BYTES } from "@/lib/validation/resources";

/**
 * Slack allowed over the file ceiling for the multipart envelope itself
 * (boundaries, part headers, the metadata fields). A request larger than this
 * is refused on `content-length` before any of it is buffered.
 */
const FORM_SLACK_BYTES = 256 * 1024;
const MAX_FORM_BYTES = MAX_FILE_BYTES + FORM_SLACK_BYTES;

const UPLOAD_RATE_MESSAGE =
  "Too many uploads — wait about a minute and try again.";

function unauthenticated(): NextResponse {
  return errorResponse("unauthenticated", "Sign in to manage your files.", 401);
}

/**
 * GET /api/resources — one page of resources for one scope.
 *
 * `?scope=personal` (the default) lists only the caller's own private files;
 * `?room_id=…` lists only files shared into that room, and only while the
 * caller is a member of it. Membership is confirmed first so a non-member gets
 * the same 404 the workspace gives, and RLS narrows the rows a second time.
 *
 * The response also carries `quota` for the listed scope (personal → the
 * caller's own total, room → the room's total), so the UI can show how much
 * of the limit is used before anybody tries an upload that would fail.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "resources": [...], "limit": n, "offset": n, "has_more": bool, "quota": {…} }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "resources_failed" } }` |
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return unauthenticated();
  }

  const search = request.nextUrl.searchParams;
  const raw: Record<string, string> = {};
  for (const key of ["scope", "room_id", "q", "subject", "chapter", "limit", "offset"]) {
    const value = search.get(key);
    if (value !== null) {
      raw[key] = value;
    }
  }

  const parsed = resourceListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const roomId = parsed.data.room_id;
  const scope = roomId !== undefined ? "room" : "personal";

  try {
    if (roomId !== undefined) {
      await requireRoomMembership(supabase, roomId);
    }

    const [page, quota] = await Promise.all([
      listResources(supabase, {
        viewerId: claims.sub,
        scope,
        roomId,
        q: parsed.data.q,
        subject: parsed.data.subject,
        chapter: parsed.data.chapter,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      }),
      fetchResourceQuota(supabase, roomId ?? null),
    ]);

    return NextResponse.json({ ...page, quota });
  } catch (error) {
    if (error instanceof RoomAccessError || error instanceof ResourceError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/resources] list failed:", error);
    return errorResponse(
      "resources_failed",
      "Your files could not be loaded. Please try again.",
      500,
    );
  }
}

/**
 * POST /api/resources — upload one file.
 *
 * Identity never comes from the request: the session decides the owner, the
 * database stamps it through the column default, and the storage key is built
 * from trusted values only. Unknown multipart fields are rejected outright, so
 * an `owner_id` in the body is an error the caller can see rather than a value
 * that silently goes nowhere.
 *
 * Abuse controls run in cost order. Two rate limits apply: an overall
 * per-user ceiling, taken *before* the body is buffered so a flood of
 * requests costs nothing but a counter, and a per-target ceiling (this room
 * or the personal library), taken once the multipart body — and therefore
 * the `room_id` — is known. Then the quota pre-check refuses an over-limit
 * upload before the bytes are written; the quota trigger re-decides inside
 * the inserting transaction, so a race lands on 409 with the object rolled
 * back rather than on a silently overshot limit.
 *
 * The object is written before the metadata row. If the row cannot be
 * written — quota, RLS, a vanished room — the object is removed again so a
 * failed upload never leaves a file that nothing points at.
 *
 * Responses: see docs/API_CONTRACTS.md — 201 on success, 400 (`validation`,
 * `invalid_request`, `invalid_filename`, `empty_file`, `malformed_file`),
 * 401, 404, 409 (`quota_exceeded`), 413 (`file_too_large`), 415
 * (`unsupported_file_type`), 429 (`rate_limited`) and 500
 * (`storage_upload_failed`, `metadata_failed`).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return unauthenticated();
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FORM_BYTES) {
    return errorResponse(
      "file_too_large",
      `Files must be ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MiB or smaller.`,
      413,
    );
  }

  // Per-user ceiling, before the body is read: a caller over their limit is
  // refused without parsing a single byte of multipart.
  const userLimited = await rateLimitedResponse(
    supabase,
    uploadUserSpec(claims.sub),
    UPLOAD_RATE_MESSAGE,
  );
  if (userLimited) {
    return userLimited;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      "invalid_request",
      "The upload must be sent as multipart/form-data.",
      400,
    );
  }

  const parsed = await parseUploadForm(form);
  if (parsed.kind === "error") {
    return errorResponse(parsed.code, parsed.message, parsed.status, parsed.issues);
  }

  const { metadata, accepted, file } = parsed;
  const roomId = metadata.room_id ?? null;

  // Per-target ceiling, now that the multipart body has told us which room
  // (or the personal library) this upload is aimed at.
  const targetLimited = await rateLimitedResponse(
    supabase,
    uploadTargetSpec(claims.sub, roomId),
    UPLOAD_RATE_MESSAGE,
  );
  if (targetLimited) {
    return targetLimited;
  }

  try {
    if (roomId !== null) {
      await requireRoomMembership(supabase, roomId);
    }
  } catch (error) {
    if (error instanceof RoomAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error("[api/resources] membership check failed:", error);
    return errorResponse(
      "metadata_failed",
      "The file could not be uploaded. Please try again.",
      500,
    );
  }

  // Pre-check: refuse an over-quota upload before anything is written. The
  // quota trigger is what actually enforces the limit — see migration 0010.
  const withinQuota = await resourceQuotaOk(supabase, roomId, file.bytes.length);
  if (!withinQuota) {
    return errorResponse("quota_exceeded", QUOTA_EXCEEDED_MESSAGE, 409);
  }

  const resourceId = crypto.randomUUID();
  const storagePath = buildStoragePath(
    roomId === null
      ? { kind: "personal", ownerId: claims.sub }
      : { kind: "room", roomId, ownerId: claims.sub },
    resourceId,
    accepted.extension,
  );

  try {
    await uploadResourceObject(supabase, storagePath, file.bytes, accepted.content_type);
  } catch (error) {
    if (error instanceof ResourceError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error("[api/resources] storage upload failed:", error);
    return errorResponse(
      "storage_upload_failed",
      "The file could not be saved. Please try again.",
      500,
    );
  }

  try {
    const resource = await insertResource(supabase, {
      id: resourceId,
      roomId,
      storagePath,
      title: metadata.title,
      originalFilename: file.name.trim(),
      contentType: accepted.content_type,
      sizeBytes: file.bytes.length,
      subject: metadata.subject,
      chapter: metadata.chapter,
    });
    return NextResponse.json({ resource }, { status: 201 });
  } catch (error) {
    // The object exists but nothing may point at it: remove it before
    // answering, so a failed upload never leaves an unreachable file behind.
    try {
      await removeResourceObject(supabase, storagePath);
    } catch (cleanupError) {
      console.error(
        "[api/resources] rollback of orphan object failed:",
        cleanupError instanceof ResourceError ? cleanupError.code : cleanupError,
      );
    }

    if (error instanceof ResourceError) {
      return errorResponse(error.code, error.message, error.status);
    }
    console.error("[api/resources] metadata insert failed:", error);
    return errorResponse(
      "metadata_failed",
      "The file could not be saved. Please try again.",
      500,
    );
  }
}
