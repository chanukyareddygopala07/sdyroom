import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError } from "@/lib/communities/access";
import { CommunityError, createCommunity, listCommunities } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  createCommunitySchema,
  listCommunitiesQuerySchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityCreateSpec } from "@/lib/rate-limit/keys";

/**
 * GET /api/communities — discovery list of PUBLIC communities.
 *
 * Signed-in only; private communities never appear here regardless of the
 * query, and RLS narrows again as defence in depth. Filters: category, free
 * text over name/description.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "communities": [...], "has_more": bool }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "communities_failed" } }` |
 */
async function GET_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to browse communities.",
      401,
    );
  }

  const search = request.nextUrl.searchParams;
  const category = search.get("category");
  const q = search.get("q");
  const limit = search.get("limit");
  const parsedQuery = listCommunitiesQuerySchema.safeParse({
    ...(category !== null ? { category } : {}),
    ...(q !== null ? { q } : {}),
    ...(limit !== null ? { limit } : {}),
  });
  if (!parsedQuery.success) {
    return validationResponse(parsedQuery.error);
  }

  try {
    const page = await listCommunities(supabase, parsedQuery.data);
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities] list failed:", errorFields(error));
    return errorResponse(
      "communities_failed",
      "Communities could not be loaded.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);

/**
 * POST /api/communities — create a community.
 *
 * Identity, ownership and the default `general` channel are pinned inside the
 * `create_community` RPC to `auth.uid()`; the body cannot name an owner.
 * The caller becomes an active member in the same transaction.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "community": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 409 | `{ "error": { "code": "slug_taken" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "community_create_failed" } }` |
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to create a community.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = createCommunitySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityCreateSpec(claims.sub),
    "You're creating communities too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const community = await createCommunity(supabase, {
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      category: parsed.data.category,
      visibility: parsed.data.visibility,
      joinPolicy:
        parsed.data.visibility === "private"
          ? "request"
          : (parsed.data.joinPolicy ?? "open"),
      rules: parsed.data.rules ?? "",
    });
    return NextResponse.json({ community }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityError || error instanceof CommunityAccessError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities] create failed:", errorFields(error));
    return errorResponse(
      "community_create_failed",
      "The community could not be created. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
