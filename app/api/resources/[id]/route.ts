
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
 * DELETE /api/resources/[id]
 *
 * Personal resources:
 *   Only the uploader may delete them.
 *
 * Shared resources:
 *   The uploader, room owner, or appointed moderator may delete them.
 *
 * For moderator deletion, the database RPC re-checks authorization and
 * deletes the metadata row plus its audit entry in one transaction.
 *
 * Storage is removed before metadata, so a Storage failure does not remove
 * the database row. Storage and database changes are separate operations;
 * if the database operation fails after Storage removal, retrying can
 * converge because Storage deletion is idempotent.
 */
export async function DELETE(
  request: NextRequest,
  { params }: ResourceContext,
) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to delete a file.",
      401,
    );
  }

  const { id } = await params;
  const parsedId = resourceIdSchema.safeParse(id);

  if (!parsedId.success) {
    return errorResponse(
      "validation",
      "That resource id is not valid.",
      400,
      [{ path: "id", message: "Resource id must be a UUID." }],
    );
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
    // RLS hides resources the caller is not allowed to see.
    const locator = await findResourceLocator(supabase, parsedId.data);

    if (!locator) {
      return errorResponse(
        "not_found",
        "That resource does not exist or is not available.",
        404,
      );
    }

    // Ownership is taken from the server-generated storage path,
    // never from a value supplied by the caller.
    const uploadedByCaller = isOwnedBy(
      locator.storage_path,
      claims.sub,
    );

    let moderatedSharedDelete = false;

    // Another user's shared resource may be deleted only by the room
    // owner or an appointed moderator.
    if (!uploadedByCaller && locator.room_id !== null) {
      const { data: role, error: roleError } = await supabase.rpc(
        "moderation_actor_role",
        { p_room_id: locator.room_id },
      );

      if (roleError) {
        console.error(
          "[api/resources] moderation role check failed:",
          roleError.message,
        );

        throw new Error("Moderation role check failed");
      }

      if (role !== "owner" && role !== "moderator") {
        return errorResponse(
          "not_found",
          "That resource does not exist or is not available.",
          404,
        );
      }

      moderatedSharedDelete = true;
    }

    // Personal resources remain uploader-only.
    if (!uploadedByCaller && !moderatedSharedDelete) {
      return errorResponse(
        "not_found",
        "That resource does not exist or is not available.",
        404,
      );
    }

    // Delete the Storage object first. Its DELETE policy independently
    // checks uploader ownership or room-scoped moderation permission.
    await removeResourceObject(supabase, locator.storage_path);

    if (moderatedSharedDelete) {
      // Re-check authorization in the database and atomically delete the
      // metadata row and append the moderation audit entry.
      const { data: result, error: deleteError } = await supabase.rpc(
        "delete_moderated_resource",
        { p_resource_id: parsedId.data },
      );

      if (deleteError) {
        console.error(
          "[api/resources] moderated delete failed:",
          deleteError.message,
        );

        throw new ResourceError(
          "delete_failed",
          "The resource could not be deleted. Please try again.",
          500,
        );
      }

      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        result.code !== "deleted"
      ) {
        throw new ResourceError(
          "delete_failed",
          "The resource could not be deleted. Please try again.",
          500,
        );
      }
    } else {
      // The uploader continues to use the existing metadata deletion path.
      const removed = await deleteResourceMetadata(
        supabase,
        parsedId.data,
      );

      if (!removed) {
        return errorResponse(
          "not_found",
          "That resource does not exist or is not available.",
          404,
        );
      }
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
