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
