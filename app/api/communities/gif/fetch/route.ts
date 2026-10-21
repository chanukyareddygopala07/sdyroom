import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { GifProxyError, fetchGif } from "@/lib/communities/gif";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityGifFetchSpec } from "@/lib/rate-limit/keys";

const fetchBodySchema = z
  .object({
    url: z.url("That GIF URL is not valid."),
  })
  .strict();

/**
 * POST /api/communities/gif/fetch — download one GIF's bytes through the
 * server. The URL must be on the configured provider's host allow-list, the
 * response must be `image/gif`, and the body is capped at 5 MB. The client
 * then encrypts these bytes like any other attachment before announcing them
 * in an E2EE message, so the stored object is ciphertext too.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `image/gif` bytes |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 502 | `{ "error": { "code": "gif_provider_failed" } }` |
 * | 503 | `{ "error": { "code": "gif_unavailable" } }` |
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to download GIFs.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = fetchBodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityGifFetchSpec(claims.sub),
    "You're downloading GIFs too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const { bytes } = await fetchGif(parsed.data.url);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "image/gif",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (error instanceof GifProxyError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/gif] fetch failed:", errorFields(error));
    return errorResponse(
      "gif_provider_failed",
      "The GIF could not be downloaded. Please try again.",
      502,
    );
  }
}

export const POST = withLogging(POST_raw);
