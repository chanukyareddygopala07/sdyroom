import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, validationResponse } from "@/lib/api/responses";
import { GifProxyError, searchGifs } from "@/lib/communities/gif";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityGifSpec } from "@/lib/rate-limit/keys";

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, "A search query is required.").max(60, "Search must be 60 characters or fewer."),
});

/**
 * GET /api/communities/gif/search?q= — GIF search proxied through the
 * server. The browser never talks to the provider, so the provider learns
 * nothing about who searched or from where; the caller must be signed in and
 * is rate limited. With no `GIF_PROVIDER`/`GIF_API_KEY` configured the route
 * answers 503 and the composer hides the tab.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ "gifs": [{ id, preview_url, full_url, width, height }] }` |
 * | 400 | `{ "error": { "code": "validation" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 502 | `{ "error": { "code": "gif_provider_failed" } }` |
 * | 503 | `{ "error": { "code": "gif_unavailable" } }` |
 */
async function GET_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to search GIFs.", 401);
  }

  const parsedQuery = searchQuerySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
  });
  if (!parsedQuery.success) {
    return validationResponse(parsedQuery.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityGifSpec(claims.sub),
    "You're searching GIFs too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const gifs = await searchGifs(parsedQuery.data.q);
    return NextResponse.json({ gifs });
  } catch (error) {
    if (error instanceof GifProxyError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/gif] search failed:", errorFields(error));
    return errorResponse(
      "gif_provider_failed",
      "GIFs could not be loaded. Please try again.",
      502,
    );
  }
}

export const GET = withLogging(GET_raw);
