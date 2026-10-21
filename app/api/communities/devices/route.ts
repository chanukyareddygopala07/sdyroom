import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import { CommunityError, registerCommunityDevice } from "@/lib/communities/queries";
import { createClient } from "@/lib/supabase/server";
import { registerCommunityDeviceSchema } from "@/lib/validation/communities";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { communityDeviceSpec } from "@/lib/rate-limit/keys";

/**
 * POST /api/communities/devices — publish this browser's MLS key package for
 * the caller. A key package is PUBLIC credential material by design (that is
 * how MLS enrollment works): it contains public keys only, never a private
 * key, and registering one does not join any community. RLS allows self-writes
 * only, so nobody can register a package on someone else's behalf.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 201 | `{ "device": {...} }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 429 | `{ "error": { "code": "rate_limited" } }` + `Retry-After` |
 * | 500 | `{ "error": { "code": "device_register_failed" } }` |
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse("unauthenticated", "Sign in to register a device.", 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse("invalid_json", "The request body must be JSON.", 400);
  }

  const parsed = registerCommunityDeviceSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    communityDeviceSpec(claims.sub),
    "You're registering devices too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const device = await registerCommunityDevice(supabase, claims.sub, {
      deviceId: parsed.data.deviceId,
      keyPackage: parsed.data.keyPackage,
      signaturePublicKey: parsed.data.signaturePublicKey,
    });
    return NextResponse.json({ device }, { status: 201 });
  } catch (error) {
    if (error instanceof CommunityError) {
      return errorResponse(error.code, error.message, error.status);
    }
    logError("[api/communities/devices] register failed:", errorFields(error));
    return errorResponse(
      "device_register_failed",
      "The device could not be registered. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
