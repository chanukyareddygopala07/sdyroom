import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityAccessError, requireCommunityMembership } from "@/lib/communities/access";
import { CommunityError, createCommunityReport } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import {
  communityIdSchema,
  createCommunityReportSchema,
} from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityReportSpec } from "@/lib/rate-limit/keys";

type ReportsContext = { params: Promise<{ id: string }> };

/**
 * POST /api/communities/[id]/reports — file a report about a message or
 * member. Because message content is end-to-end encrypted, the server CANNOT
 * scan it: the reporter may voluntarily include a decrypted `contextExcerpt`
 * of the specific message they are reporting, knowing it becomes visible to
 * community staff. Reports without an excerpt still work — target ids,
 * reporter identity and reason are already actionable metadata.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "report": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "report_create_failed" } }` |
 */
async function POST_raw(request: NextRequest, { params }: ReportsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to file reports.", 401);
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

  const parsed = createCommunityReportSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityReportSpec(parsedId.data, claims.sub),
    "You're filing reports too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    await requireCommunityMembership(supabase, parsedId.data, claims.sub);

    const report = await createCommunityReport(supabase, {
      communityId: parsedId.data,
      reporterId: claims.sub,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      reason: parsed.data.reason,
      contextExcerpt: parsed.data.contextExcerpt ?? null,
    });
    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityAccessError || error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/reports] create failed:", errorFields(error));
    return errorResponse(
      "report_create_failed",
      "The report could not be filed. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
