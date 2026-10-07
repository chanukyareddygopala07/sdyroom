import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readJsonBody, validationResponse } from "@/lib/api/responses";
import { ModerationError } from "@/lib/moderation/errors";
import { setReportStatus } from "@/lib/moderation/queries";
import { createClient } from "@/lib/supabase/server";
import { reportIdSchema, updateReportStatusSchema } from "@/lib/validation/moderation";

type ReportContext = { params: Promise<{ reportId: string }> };

/**
 * PATCH /api/reports/[reportId] — advance one report through
 * `pending → reviewing → resolved | dismissed`. The room is never in the
 * path: the report id is opaque, the RPC re-derives the room, and it checks
 * that the caller is its owner or moderator. A caller from another room —
 * or no room at all — receives the exact same 404 a missing report gets, so
 * this endpoint is not an existence oracle. Every transition writes one
 * `moderation_actions` audit row with the actor's uuid (server-side only).
 *
 * Request: `{ "status": "reviewing" | "resolved" | "dismissed" }` —
 * `pending` cannot be set (it is where reports start) and terminal states
 * never reopen; both are 409 `invalid_transition`.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "report": { id, status } }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing report or caller lacks moderator rights there |
 * | 409 | `{ "error": { "code": "invalid_transition" } }` |
 * | 500 | `{ "error": { "code": "report_failed" } }` |
 */
export async function PATCH(request: NextRequest, { params }: ReportContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to update reports.", 401);
  }

  const { reportId } = await params;
  const parsedReportId = reportIdSchema.safeParse(reportId);
  if (!parsedReportId.success) {
    return errorResponse("validation", "That report id is not valid.", 400, [
      { path: "reportId", message: "Report id must be a UUID." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsedUpdate = updateReportStatusSchema.safeParse(parsedBody.body);
  if (!parsedUpdate.success) {
    return validationResponse(parsedUpdate.error);
  }

  try {
    const report = await setReportStatus(
      supabase,
      parsedReportId.data,
      parsedUpdate.data.status,
    );
    return NextResponse.json({ report });
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/reports] status update failed:", error);
    return errorResponse(
      "report_failed",
      "The report could not be updated. Please try again.",
      500,
    );
  }
}
