import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import {
  CommunityError,
  createCommunityAttachment,
  getCommunityChannel,
} from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityIdSchema,
  createCommunityAttachmentSchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityAttachmentSpec } from "@/lib/rate-limit/keys";

type AttachmentsContext = { params: Promise<{ id: string }> };

/**
 * POST /api/communities/[id]/attachments — register one encrypted attachment.
 * The client has already uploaded ciphertext bytes to the private
 * `community-attachments` bucket at `storagePath`; this row is the
 * metadata pointer other members resolve into a signed download URL. The
 * server stores sizes and a storage path only — never plaintext, never a
 * key: the AES-256-GCM key travelled inside the E2EE message payload that
 * announced this attachment.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "attachment": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "attachment_create_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: AttachmentsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to attach files.", 401);
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

  const parsed = createCommunityAttachmentSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityAttachmentSpec(parsedId.data, claims.sub),
    "You're uploading attachments too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);
    const channel = await getCommunityChannel(
      supabase,
      parsedId.data,
      parsed.data.channelId,
    );

    // The storage path must be namespaced under this community and channel;
    // the bucket's RLS re-derives membership from the same prefix.
    const expectedPrefix = `community-attachments/${parsedId.data}/${channel.id}/`;
    if (!parsed.data.storagePath.startsWith(expectedPrefix)) {
      return errorResponse(
        "validation",
        "storagePath must be inside this community and channel.",
        400,
      );
    }

    const attachment = await createCommunityAttachment(supabase, {
      communityId: parsedId.data,
      channelId: channel.id,
      uploaderId: claims.sub,
      storagePath: parsed.data.storagePath,
      ciphertextSize: parsed.data.ciphertextSize,
      contentType: parsed.data.contentType,
    });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/attachments] create failed:", errorFields(error));
    return errorResponse(
      "attachment_create_failed",
      "The attachment could not be saved. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
