import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import {
  CommunityAccessError,
  requireCommunityMembership,
  requireCommunityStaff,
  requireCommunityVisibility,
} from "@/lib/communities/access";
import {
  CommunityError,
  getCommunity,
  updateCommunity,
} from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityIdSchema,
  updateCommunitySchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

type CommunityContext = { params: Promise<{ id: string }> };

/**
 * GET /api/communities/[id] — one community plus the caller's membership.
 *
 * Public rows are readable by any signed-in user (discovery preview);
 * private rows require active membership and otherwise answer 404, so the
 * route is not an existence oracle. `membership` is null for signed-out-of-
 * membership viewers and carries role/status otherwise; the UI keys join
 * state off it.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "community": {...}, "membership": {...} \| null }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "community_failed" } }` |
 */
async function GET_raw(_request: NextRequest, { params }: CommunityContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view communities.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  try {
    const visibility = await requireCommunityVisibility(
      supabase,
      parsedId.data,
      claims.sub,
    );
    const community = await getCommunity(supabase, parsedId.data);

    const { data: membership } = await supabase
      .from("community_members")
      .select("role, status, joined_at")
      .eq("community_id", parsedId.data)
      .eq("user_id", claims.sub)
      .maybeSingle();

    return NextResponse.json({
      community,
      membership:
        membership && membership.status === "active"
          ? {
              role: membership.role,
              status: membership.status,
              joined_at: membership.joined_at,
            }
          : membership
            ? { role: membership.role, status: membership.status, joined_at: membership.joined_at }
            : null,
      visibility: visibility.visibility,
    });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/id] get failed:", errorFields(error));
    return errorResponse("community_failed", "The community could not be loaded.", 500);
  }
}

export const GET = withLogging(GET_raw);

/**
 * PATCH /api/communities/[id] — staff edit of name/description/category/
 * visibility/join policy/rules. Ownership cannot be transferred here; the
 * RLS `with check` re-pins `owner_id` to the existing owner row.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "community": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "slug_taken" } }` |
 * | 500 | `{ "error": { "code": "community_update_failed" } }` |
 */
async function PATCH_raw(request: NextRequest, { params }: CommunityContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to edit communities.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = updateCommunitySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  try {
    await requireCommunityStaff(supabase, parsedId.data, claims.sub);

    const patch: Record<string, string> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.category !== undefined) patch.category = parsed.data.category;
    if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;
    if (parsed.data.joinPolicy !== undefined) patch.join_policy = parsed.data.joinPolicy;
    if (parsed.data.rules !== undefined) patch.rules = parsed.data.rules;

    // Demoting visibility to private must not leave an `open` join policy
    // (the table CHECK would reject it): default to request-based joining.
    if (patch.visibility === "private" && patch.join_policy === "open") {
      patch.join_policy = "request";
    }
    if (parsed.data.visibility === "private" && patch.join_policy === undefined) {
      const current = await getCommunity(supabase, parsedId.data);
      if (current.join_policy === "open") {
        patch.join_policy = "request";
      }
    }

    const community = await updateCommunity(supabase, parsedId.data, patch);
    return NextResponse.json({ community });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/id] update failed:", errorFields(error));
    return errorResponse(
      "community_update_failed",
      "The community could not be updated. Please try again.",
      500,
    );
  }
}

export const PATCH = withLogging(PATCH_raw);

/**
 * DELETE /api/communities/[id] — owner deletes the community and everything
 * under it (members, channels, messages, attachments) via cascade.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 204 | empty |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "community_delete_failed" } }` |
 */
async function DELETE_raw(_request: NextRequest, { params }: CommunityContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to delete communities.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  try {
    // Membership first: a non-owner gets 404, not a role error.
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);
    // `.select("id")` makes the outcome observable: PostgREST answers a
    // policy-filtered DELETE with success over zero rows, never an error, so
    // an empty result — not deleteError — is how a non-owner's attempt
    // announces itself.
    const { data: deletedRows, error: deleteError } = await supabase
      .from("communities")
      .delete()
      .eq("id", parsedId.data)
      .select("id");

    if (deleteError || !deletedRows?.length) {
      // RLS filters non-owners silently; surface 403 for members who are not
      // owners (and for the owner only when the delete genuinely failed).
      const { data: membership } = await supabase
        .from("community_members")
        .select("role")
        .eq("community_id", parsedId.data)
        .eq("user_id", claims.sub)
        .maybeSingle();
      if (membership?.role !== "owner") {
        throw new CommunityAccessError(
          "forbidden",
          "Only the community owner can delete a community.",
          403,
        );
      }
      if (deleteError) {
        throw deleteError;
      }
      // Owner, no error, yet nothing was removed: the row vanished between
      // the membership gate and the delete. Fail honestly rather than 204.
      throw new Error("community delete removed no row");
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/id] delete failed:", errorFields(error));
    return errorResponse(
      "community_delete_failed",
      "The community could not be deleted. Please try again.",
      500,
    );
  }
}

export const DELETE = withLogging(DELETE_raw);
