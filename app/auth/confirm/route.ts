import { safeInternalPath } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

/**
 * The email-template OTP types this endpoint will verify. Anything else
 * (`type=` is query-string input, see PR 21 B4) is refused before it
 * reaches `verifyOtp`.
 */
const ALLOWED_OTP_TYPES = new Set<string>([
  "signup",
  "email",
  "invite",
  "email_change",
  "recovery",
  "magiclink",
]);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeInternalPath(searchParams.get("next")) ?? "/rooms";

  if (token_hash && type && ALLOWED_OTP_TYPES.has(type)) {
    const supabase = await createClient();

    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash,
    });
    if (!error) {
      // Only a verified site-internal path is ever used as a target (PR 21).
      redirect(next);
    } else {
      // redirect the user to an error page with some instructions
      redirect(`/auth/error?error=${encodeURIComponent(error.message)}`);
    }
  }

  // redirect the user to an error page with some instructions
  const reason =
    token_hash && type
      ? "Unsupported confirmation type"
      : "No token hash or type";
  redirect(`/auth/error?error=${encodeURIComponent(reason)}`);
}
