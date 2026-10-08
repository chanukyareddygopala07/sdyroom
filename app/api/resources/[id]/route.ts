import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { resourceDeleteSpec } from "@/lib/rate-limit/keys";
import {
  deleteResourceMetadata,
  findResourceLocator,
  ResourceError,
} from "@/lib/resources/queries";
import { isOwnedBy, removeResourceObject } from "@/lib/resources/storage";
import { createClient } from "@/lib/supabase/server";
import { resourceIdSchema } from "@/lib/validation/resources";

type ResourceContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/resources/[id] — remove a resource for good.
 *
 * Order matters and is deliberate:
 *
 *  1. Resolve the row. RLS answers "is this resource visible to me?", so a
 *     missing id and somebody else's id both become 404 without revealing
 *     which.
 *  2. Confirm the caller is the uploader, from the server-built key. A room
 *     member can see a shared file but must never reach step 3 for it — the
 *     storage policy would refuse the write anyway, but a rule that is only
 *     enforced by accident is a rule nobody has actually checked.
 *  3. Remove the object first. Deletion is idempotent, so a retry after any
 *     partial failure converges; and because the object goes before the row,
 *     a failure here changes nothing and `cleanup_failed` means "try again"
 *     rather than "it half-worked".
 *  4. Remove the row. If this fails, `delete_failed` is returned and a retry
 *     re-runs both steps safely.
 *
 * The opposite order was rejected on purpose: a row removed first would leave
 * a file advertised in the list that could never be downloaded, and would make
 * a 500 a lie about what actually happened.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "deleted": true }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "delete_failed" \| "cleanup_failed" } }` |
 */
export async function DELETE(request: NextRequest, { params }: ResourceContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to delete a file.", 401);
  }

  const { id } = await params;
  const parsedId = resourceIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That resource id is not valid.", 400, [
      { path: "id", message: "Resource id must be a UUID." },
    ]);
  }

  const limited = await rateLimitedResponse(
    supabase,
    resourceDeleteSpec(claims.sub),
    "Too many delete requests — wait about a minute and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const locator = await findResourceLocator(supabase, parsedId.data);
    if (!locator || !isOwnedBy(locator.storage_path, claims.sub)) {
      return errorResponse(
        "not_found",
        "That resource does not exist or is not available.",
        404,
      );
    }

    await removeResourceObject(supabase, locator.storage_path);

    const removed = await deleteResourceMetadata(supabase, parsedId.data);
    if (!removed) {
      // The row went away between the lookup and the delete — somebody with
      // the same rights already finished the job. Nothing is half-done.
      return errorResponse(
        "not_found",
        "That resource does not exist or is not available.",
        404,
      );
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof ResourceError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/resources] delete failed:", error);
    return errorResponse(
      "delete_failed",
      "The resource could not be deleted. Please try again.",
      500,
    );
  }
}
