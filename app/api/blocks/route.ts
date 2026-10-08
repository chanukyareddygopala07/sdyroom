import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readJsonBody, validationResponse } from "@/lib/api/responses";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { blockSpec } from "@/lib/rate-limit/keys";
import { ModerationError } from "@/lib/moderation/errors";
import { createBlock, listBlocks } from "@/lib/moderation/queries";
import { createClient } from "@/lib/supabase/server";
import { blockCreateSchema } from "@/lib/validation/moderation";

/**
 * GET /api/blocks — the caller's own block list: aliases and when they were
 * added, newest first. `list_my_blocks` is a SECURITY DEFINER read over rows
 * only the caller's own `blocker_id` can match; the `user_blocks` table
 * itself exposes just that same own-row slice to PostgREST, so no client can
 * read anyone else's blocks through either path.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "blocks": [{ alias, created_at }], "count": number }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 500 | `{ "error": { "code": "blocks_failed" } }` |
 */
export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to view your blocks.", 401);
  }

  try {
    const blocks = await listBlocks(supabase);
    return NextResponse.json({ blocks, count: blocks.length });
  } catch (error) {
    console.error("[api/blocks] list failed:", error);
    return errorResponse(
      "blocks_failed",
      "Your block list could not be loaded.",
      500,
    );
  }
}

/**
 * POST /api/blocks — block a student by alias. The target is resolved to a
 * uuid inside the RPC (`profiles` is RLS own-only, so no lookup is possible
 * from the wire), and the row stores `blocker_id = auth.uid()` — a body can
 * never name someone else as the blocker. Blocking takes effect entirely
 * server-side: the blocker stops receiving the target's messages through the
 * `room_messages` SELECT policy, and the pair can no longer complete an
 * invitation accept. Repeating a block is idempotent (200, `created: false`).
 *
 * Request: `{ "alias": "..." }`
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "block": { alias, created_at }, "created": false }` — already blocked |
 * | 201 | `{ "block": { alias, created_at }, "created": true }` |
 * | 400 | `{ "error": { "code": "validation" } \| { "code": "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — no student studies under that alias |
 * | 409 | `{ "error": { "code": "self_block" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "blocks_failed" } }` |
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return errorResponse("unauthenticated", "Sign in to block a student.", 401);
  }

  const limited = await rateLimitedResponse(
    supabase,
    blockSpec(data.claims.sub),
    "Too many block changes — wait a while and try again.",
  );
  if (limited) {
    return limited;
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsedBlock = blockCreateSchema.safeParse(parsedBody.body);
  if (!parsedBlock.success) {
    return validationResponse(parsedBlock.error);
  }

  try {
    const block = await createBlock(supabase, parsedBlock.data.alias);
    return NextResponse.json(
      { block: { alias: block.alias, created_at: block.created_at }, created: block.created },
      { status: block.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof ModerationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    console.error("[api/blocks] create failed:", error);
    return errorResponse(
      "blocks_failed",
      "That student could not be blocked. Please try again.",
      500,
    );
  }
}
