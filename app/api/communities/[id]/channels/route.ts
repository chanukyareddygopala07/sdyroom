import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership, requireCommunityStaff } from "@/lib/communities/access";
import { CommunityError, listCommunityChannels } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityIdSchema,
  createChannelSchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityChannelSpec } from "@/lib/rate-limit/keys";

type ChannelsContext = { params: Promise<{ id: string }> };

/**
 * GET /api/communities/[id]/channels — the member-visible channel list.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "channels": [...] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "channels_failed" } }` |
 */
async function GET_raw(_request: NextRequest, { params }: ChannelsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view channels.", 401);
  }

  const { id } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse("validation", "That community id is not valid.", 400, [
      { path: "id", message: "Community id must be a UUID." },
    ]);
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);
    const channels = await listCommunityChannels(supabase, parsedId.data);
    return NextResponse.json({ channels });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/channels] list failed:", errorFields(error));
    return errorResponse("channels_failed", "Channels could not be loaded.", 500);
  }
}

export const GET = withLogging(GET_raw);

/**
 * POST /api/communities/[id]/channels — create a channel (staff only).
 * The MLS group for the new channel is created by the first member client
 * that opens it; the server only books the row.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "channel": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 409 | `{ "error": { "code": "channel_exists" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "channel_create_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: ChannelsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to create channels.", 401);
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

  const parsed = createChannelSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityChannelSpec(parsedId.data, claims.sub),
    "You're creating channels too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityStaff(supabase, parsedId.data, claims.sub);

    const { data: existing } = await supabase
      .from("community_channels")
      .select("id")
      .eq("community_id", parsedId.data)
      .eq("slug", parsed.data.slug)
      .maybeSingle();
    if (existing) {
      throw new CommunityError(
        "channel_exists",
        "A channel with that slug already exists.",
        409,
      );
    }

    const { data: positionRow } = await supabase
      .from("community_channels")
      .select("position")
      .eq("community_id", parsedId.data)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: channel, error } = await supabase
      .from("community_channels")
      .insert({
        community_id: parsedId.data,
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: parsed.data.description,
        position: (positionRow?.position ?? 0) + 1,
      })
      .select("*")
      .single();

    if (error) {
      throw new CommunityError(
        "channel_create_failed",
        "The channel could not be created. Please try again.",
        500,
      );
    }
    return NextResponse.json({ channel }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/channels] create failed:", errorFields(error));
    return errorResponse(
      "channel_create_failed",
      "The channel could not be created. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
