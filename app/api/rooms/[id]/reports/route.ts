import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readJsonBody, validationResponse } from "@/lib/api/responses";
import { ModerationError } from "@/lib/moderation/errors";
import { createReport, listReports } from "@/lib/moderation/queries";
import {
  requireRoomMembership,
  RoomAccessError,
} from "@/lib/rooms/access";
import { createClient } from "@/lib/supabase/server";
import {
  createReportSchema,
  reportsQuerySchema,
} from "@/lib/validation/moderation";
import { roomIdSchema } from "@/lib/validation/rooms";

type ReportsContext = { params: Promise<{ id: string }> };

/**
 * GET /api/rooms/[id]/reports — the room moderation inbox: recent reports
 * for this room, newest first. The payload is the RPC's explicit projection
 * (`room_report_list`): no reporter id ever crosses the wire, and the
 * subject's user id only appears as its alias. Owner and moderators only —
 * a plain member gets 403 `not_moderator` from the RPC's own actor check.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "reports": [{ id, subject_type, subject_id, subject_alias, reason, detail, status, created_at, resolved_at, resolved_by }], "count": number }` |
 * | 400 | `{ "error": { "code": "validation" } }` — bad room id or limit |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "not_moderator" } }` — member but not owner/moderator |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room or non-member |
 * | 500 | `{ "error": { "code": "report_failed" } }` |
 */
export async function GET(request: NextRequest, { params }: ReportsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view reports.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedLimit = reportsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsedLimit.success) {
    return validationResponse(parsedLimit.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const reports = await listReports(
      supabase,
      parsedRoomId.data,
      parsedLimit.data.limit,
    );
    return NextResponse.json({ reports, count: reports.length });
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomAccessError) {
      return errorResponse(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }

    console.error("[api/rooms/reports] list failed:", error);
    return errorResponse(
      "report_failed",
      "The reports could not be loaded.",
      500,
    );
  }
}

/**
 * POST /api/rooms/[id]/reports — file a report against a member, a message,
 * or a resource in this room. The reporter identity is never in the body:
 * `.strict()` schemas reject any smuggled id, and the RPC takes it from
 * `auth.uid()`. Repeating an open report is idempotent (200 `duplicate`).
 *
 * Request: `{ "subject_type": "user", "subject_alias": "..." }` or
 * `{ "subject_type": "message", "subject_id": "..." }` (same for `resource`),
 * plus `reason` (closed enum) and optional `detail` (≤ 500 chars).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "report": { id, status }, "duplicate": true }` — an open report already exists |
 * | 201 | `{ "report": { id, status, created_at } }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — missing room, non-member, or unknown subject alias |
 * | 409 | `{ "error": { "code": "self_report" } \| { "code": "invalid_subject" } }` |
 * | 500 | `{ "error": { "code": "report_failed" } }` |
 */
export async function POST(request: NextRequest, { params }: ReportsContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to file a report.", 401);
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    return errorResponse("validation", "That room id is not valid.", 400, [
      { path: "id", message: "Room id must be a UUID." },
    ]);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsedReport = createReportSchema.safeParse(parsedBody.body);
  if (!parsedReport.success) {
    return validationResponse(parsedReport.error);
  }

  try {
    await requireRoomMembership(supabase, parsedRoomId.data);
    const report = await createReport(
      supabase,
      parsedRoomId.data,
      parsedReport.data,
    );

    if (report.code === "duplicate") {
      return NextResponse.json(
        {
          report: { id: report.id, status: report.status },
          duplicate: true,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        report: {
          id: report.id,
          status: report.status,
          created_at: report.created_at,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (error instanceof RoomAccessError) {
      return errorResponse(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }

    console.error("[api/rooms/reports] create failed:", error);
    return errorResponse(
      "report_failed",
      "The report could not be filed. Please try again.",
      500,
    );
  }
}
