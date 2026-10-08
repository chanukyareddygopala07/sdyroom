import { NextResponse, type NextRequest } from "next/server";
import { emptyBodyResponse, errorResponse, readEmptyBody } from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { blockSpec } from "@/lib/rate-limit/keys";
import { ModerationError } from "@/lib/moderation/errors";
import { deleteBlock } from "@/lib/moderation/queries";
import { createClient } from "@/lib/supabase/server";
import { memberAliasSchema } from "@/lib/validation/moderation";

type BlockContext = { params: Promise<{ alias: string }> };

/**
 * DELETE /api/blocks/[alias] — unblock a student. Bodyless: only rows where
 * `blocker_id = auth.uid()` are ever touched inside the RPC, so this can
 * only remove the caller's own block. Once removed, the target's messages
 * become visible to the blocker again and invitation accepts between the two
 * work again — nothing was ever deleted, it was only filtered.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "removed": true }` — or `false` when no such block existed (idempotent) |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_request" } }` — bad alias or a non-empty body |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — no student studies under that alias |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "blocks_failed" } }` |
 */
export async function DELETE(request: NextRequest, { params }: BlockContext) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to manage your blocks.", 401);
  }

  const limited = await rateLimitedResponse(
    supabase,
    blockSpec(data.claims.sub),
    "Too many block changes — wait a while and try again.",
  );
  if (limited) {
    return limited;
  }

  const { alias } = await params;
  const parsedAlias = memberAliasSchema.safeParse(alias);
  if (!parsedAlias.success) {
    return errorResponse("validation", "That alias is not valid.", 400, [
      { path: "alias", message: "Alias must be 1–32 characters." },
    ]);
  }

  const body = await readEmptyBody(request);
  const emptyBodyError = emptyBodyResponse(body);
  if (emptyBodyError) {
    return emptyBodyError;
  }

  try {
    const result = await deleteBlock(supabase, parsedAlias.data);
    return NextResponse.json({ removed: result.removed });
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/blocks] delete failed:", error);
    return errorResponse(
      "blocks_failed",
      "That block could not be removed. Please try again.",
      500,
    );
  }
}
