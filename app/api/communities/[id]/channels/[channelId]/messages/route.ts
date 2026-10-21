import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import {
  CommunityError,
  appendCommunityMessage,
  getCommunityChannel,
  listCommunityMessages,
} from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityChannelIdSchema,
  communityIdSchema,
  communityMessagesQuerySchema,
  sendCommunityMessageSchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityMessageSpec } from "@/lib/rate-limit/keys";

type MessagesContext = {
  params: Promise<{ id: string; channelId: string }>;
};

/**
 * GET /api/communities/[id]/channels/[channelId]/messages — one page of the
 * channel's CIPHERTEXT stream, newest first, as opaque MLS envelopes with
 * sender device ids and sequence numbers. The server cannot read these
 * payloads; clients decrypt locally. `before` is a `seq` cursor.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "messages": [...], "has_more": bool }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 500 | `{ "error": { "code": "messages_failed" } }` |
 */
async function GET_raw(request: NextRequest, { params }: MessagesContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to view messages.", 401);
  }

  const { id, channelId } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  const parsedChannelId = communityChannelIdSchema.safeParse(channelId);
  if (!parsedId.success || !parsedChannelId.success) {
    return errorResponse("validation", "That id is not valid.", 400, [
      { path: "id", message: "Community and channel ids must be UUIDs." },
    ]);
  }

  const search = request.nextUrl.searchParams;
  const before = search.get("before");
  const limit = search.get("limit");
  const parsedQuery = communityMessagesQuerySchema.safeParse({
    ...(before !== null ? { before } : {}),
    ...(limit !== null ? { limit } : {}),
  });
  if (!parsedQuery.success) {
    return validationResponse(parsedQuery.error);
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);
    await getCommunityChannel(supabase, parsedId.data, parsedChannelId.data);

    const page = await listCommunityMessages(supabase, parsedChannelId.data, {
      before: parsedQuery.data.before,
      limit: parsedQuery.data.limit,
    });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/messages] list failed:", errorFields(error));
    return errorResponse("messages_failed", "Messages could not be loaded.", 500);
  }
}

export const GET = withLogging(GET_raw);

/**
 * POST /api/communities/[id]/channels/[channelId]/messages — store one opaque
 * MLS envelope. `kind: "application"` is a private message; `kind: "commit"`
 * is a public membership/epoch commit. The server validates structure only —
 * base64, size, kind, idempotency key, membership — never content, which it
 * cannot read. `client_msg_id` dedupes retries.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "message": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "message_create_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: MessagesContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to send messages.", 401);
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

  const parsed = sendCommunityMessageSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityMessageSpec(parsedChannelId.data, claims.sub),
    "You're sending messages too quickly. Pause a moment and try again.",
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

    const message = await appendCommunityMessage(supabase, {
      channelId: channel.id,
      communityId: parsedId.data,
      senderId: claims.sub,
      senderDeviceId: parsed.data.senderDeviceId,
      kind: parsed.data.kind,
      ciphertext: parsed.data.ciphertext,
      clientMsgId: parsed.data.clientMsgId,
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/messages] create failed:", errorFields(error));
    return errorResponse(
      "message_create_failed",
      "The message could not be sent. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
