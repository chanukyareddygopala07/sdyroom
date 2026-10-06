import { NextResponse, type NextRequest } from "next/server";
import type { ZodError } from "zod";

export type ApiIssue = {
  path: string;
  message: string;
};

/** Uniform error envelope: `{ error: { code, message, issues? } }`. */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  issues?: ApiIssue[],
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(issues && issues.length > 0 ? { issues } : {}) } },
    { status },
  );
}

export function validationResponse(error: ZodError): NextResponse {
  return errorResponse(
    "validation",
    "Check the highlighted fields and try again.",
    400,
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

export async function readJsonBody(
  request: NextRequest,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads a request body that must be absent or an empty JSON object.
 *
 * Membership endpoints take their identity from the session only, so there is
 * nothing a body could legitimately carry. Rather than ignore unknown fields —
 * which would quietly accept a forged `user_id` — every field is reported back
 * as a 400, so a body can never look like it was honoured.
 */
export type EmptyBody =
  | { kind: "empty" }
  | { kind: "fields"; fields: string[] }
  | { kind: "invalid_json" }
  | { kind: "not_object" };

export async function readEmptyBody(request: NextRequest): Promise<EmptyBody> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { kind: "invalid_json" };
  }

  if (text.trim() === "") {
    return { kind: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid_json" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "not_object" };
  }

  const fields = Object.keys(parsed as Record<string, unknown>);
  return fields.length === 0 ? { kind: "empty" } : { kind: "fields", fields };
}

/** Shared 400 mapping for `readEmptyBody`; null when the body is acceptable. */
export function emptyBodyResponse(body: EmptyBody): NextResponse | null {
  switch (body.kind) {
    case "empty":
      return null;
    case "invalid_json":
      return errorResponse("invalid_json", "The request body must be JSON.", 400);
    case "not_object":
      return errorResponse(
        "invalid_request",
        "This endpoint accepts an empty JSON body only.",
        400,
      );
    case "fields":
      return errorResponse(
        "invalid_request",
        "This endpoint does not accept any fields.",
        400,
        body.fields.map((field) => ({ path: field, message: "Not accepted here." })),
      );
  }
}
