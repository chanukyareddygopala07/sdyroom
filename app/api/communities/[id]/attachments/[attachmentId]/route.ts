import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import { CommunityError, getCommunityAttachment } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { communityIdSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { downloadSpec } from "@/lib/rate-limit/keys";

type AttachmentContext = {
  params: Promise<{ id: string; attachmentId: string }>;
};

/**
 * GET /api/communities/[id]/attachments/[attachmentId] — short-lived signed
 * URL for the ciphertext object. Membership gates the row; the bucket's RLS
 * re-checks it from the path prefix; the returned bytes are still ciphertext
 * and only the client's AES-256-GCM key (which arrived inside the E2EE
 * message payload) turns them into the original file.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "url": string, "expires_in": number }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "attachment_url_failed" } }` |
 */
async function GET_raw(_request: NextRequest, { params }: AttachmentContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to download attachments.", 401);
  }

  const { id, attachmentId } = await params;
  const parsedId = communityIdSchema.safeParse(id);
  const parsedAttachmentId = communityIdSchema.safeParse(attachmentId);
  if (!parsedId.success || !parsedAttachmentId.success) {
    return errorResponse("validation", "That id is not valid.", 400, [
      { path: "id", message: "Community and attachment ids must be UUIDs." },
    ]);
  }

  const limited = await rateLimitedResponse(
    supabase,
    downloadSpec(claims.sub),
    "Too many download requests. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);
    const attachment = await getCommunityAttachment(
      supabase,
      parsedId.data,
      parsedAttachmentId.data,
    );

    const { data: signed, error } = await supabase.storage
      .from("community-attachments")
      .createSignedUrl(attachment.storage_path, 120);

    if (error || !signed?.signedUrl) {
      throw new Error(`signed url failed: ${error?.message ?? "no url"}`);
    }

    return NextResponse.json({ url: signed.signedUrl, expires_in: 120 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/attachments] url failed:", errorFields(error));
    return errorResponse(
      "attachment_url_failed",
      "The attachment could not be fetched. Please try again.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);
