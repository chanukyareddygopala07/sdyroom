import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import {
  CommunityError,
  appendCommunityWelcome,
  getCommunityChannel,
} from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityChannelIdSchema,
  communityIdSchema,
  sendCommunityWelcomeSchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityMessageSpec } from "@/lib/rate-limit/keys";

type WelcomesContext = {
  params: Promise<{ id: string; channelId: string }>;
};

/**
 * POST /api/communities/[id]/channels/[channelId]/welcomes — store one MLS
 * welcome envelope addressed to a single user+device, plus the public
 * ratchet-tree snapshot the joiner needs. Only the addressee can read the
 * row (RLS pins `recipient_user_id` to `auth.uid()`); the ciphertext itself
 * is only decryptable by the private key matching the target's published key
 * package, so both layers agree.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "welcome": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "welcome_create_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: WelcomesContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to send welcomes.", 401);
  }

  const { id, channelId } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  const parsedChannelId = communityChannelIdSchema.safeParse(channelId);
  if (!parsedId.success || !parsedChannelId.success) {
    return errorResponse("validation", "That id is not valid.", 400, [
      { path: "id", message: "Community and channel ids must be UUIDs." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = sendCommunityWelcomeSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  // Welcomes ride the same per-channel send budget as messages: a
  // membership-sync burst is rare, human-driven work.
  const limited = await rateLimitedResponse(
    supabase,
    communityMessageSpec(parsedChannelId.data, claims.sub),
    "You're sending membership updates too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);
    const channel = await getCommunityChannel(
      supabase,
      parsedId.data,
      parsedChannelId.data,
    );

    const welcome = await appendCommunityWelcome(supabase, {
      channelId: channel.id,
      communityId: parsedId.data,
      recipientUserId: parsed.data.recipientUserId,
      recipientDeviceId: parsed.data.recipientDeviceId,
      senderId: claims.sub,
      ciphertext: parsed.data.ciphertext,
      ratchetTree: parsed.data.ratchetTree,
      clientMsgId: parsed.data.clientMsgId,
    });
    return NextResponse.json({ welcome }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/welcomes] create failed:", errorFields(error));
    return errorResponse(
      "welcome_create_failed",
      "The welcome could not be stored. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
