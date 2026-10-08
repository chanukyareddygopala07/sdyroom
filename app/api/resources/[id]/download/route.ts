import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { downloadSpec } from "@/lib/rate-limit/keys";
import { findResourceLocator, ResourceError } from "@/lib/resources/queries";
import { createResourceDownloadUrl } from "@/lib/resources/storage";
import { createClient } from "@/lib/supabase/server";
import {
  DOWNLOAD_TTL_SECONDS,
  resourceIdSchema,
} from "@/lib/validation/resources";

type DownloadContext = { params: Promise<{ id: string }> };

/**
 * GET /api/resources/[id]/download — a short-lived signed URL.
 *
 * Authorization is re-checked on this request, not inherited from the list:
 * `findResourceLocator` runs under RLS, so a deleted resource, an id from
 * another student's library and a room you have left all answer 404
 * identically. The storage service then applies its own SELECT policy while
 * signing, which is a second, independent enforcement of the same decision —
 * a URL is never produced for an object the caller's policy forbids.
 *
 * The returned URL carries the authorization in its signed token and expires
 * after `expires_in` seconds. No permanent link, no credential and no internal
 * storage path is ever returned.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "url": "…", "expires_in": 300, "resource_id": "…" }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "download_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: DownloadContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to open this file.", 401);
  }

  const { id } = await params;
  const parsedId = resourceIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That resource id is not valid.", 400, [
      { path: "id", message: "Resource id must be a UUID." },
    ]);
  }

  // Signing a URL is cheap, so this ceiling is generous: it exists to bound
  // scripted token-minting, not to slow down a student opening their notes.
  const limited = await rateLimitedResponse(
    supabase,
    downloadSpec(claims.sub),
    "Too many download requests — wait about a minute and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const locator = await findResourceLocator(supabase, parsedId.data);
    if (!locator) {
      return errorResponse(
        "not_found",
        "That resource does not exist or is not available.",
        404,
      );
    }

    const { url, expires_in } = await createResourceDownloadUrl(
      supabase,
      locator.storage_path,
      DOWNLOAD_TTL_SECONDS,
      locator.original_filename,
    );

    return NextResponse.json({
      url,
      expires_in,
      resource_id: locator.id,
    });
  } catch (error) {
    if (error instanceof ResourceError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/resources/download] failed:", error);
    return errorResponse(
      "download_failed",
      "This file could not be opened. Please try again.",
      500,
    );
  }
}
