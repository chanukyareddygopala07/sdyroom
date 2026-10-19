"use client";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { Github } from "lucide-react";
import { useState } from "react";

type OAuthProvider = "google" | "github";

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};

/**
 * Reviewed product copy for a failed initiation. Supabase reports provider
 * misconfiguration in developer-facing terms; the card shows this line
 * instead and never surfaces the raw message.
 */
function initiationErrorCopy(provider: OAuthProvider): string {
  return `${PROVIDER_LABELS[provider]} sign-in isn't available right now. Try again, or use your email and password.`;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="size-4 shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/**
 * The "or continue with" divider plus the Google and GitHub buttons.
 *
 * Both buttons call the real Supabase OAuth flow (`signInWithOAuth`) with
 * the project's browser client; the return leg lands on `/auth/callback`,
 * which exchanges the code for a session and honours only site-internal
 * `next` targets. A provider that is not configured in Supabase surfaces
 * here as a friendly alert — never a fake success. While a redirect is in
 * flight every button in the group (and, through `onPendingChange`, the
 * password submit beside it) is disabled, so a double-click cannot start
 * two round-trips.
 */
export function OAuthButtons({
  intent,
  next = null,
  disabled = false,
  onPendingChange,
}: {
  /** "signin" offers continue-with buttons; "signup" offers sign-up-with. */
  intent: "signin" | "signup";
  /** Already server-validated site-internal path, forwarded to the callback. */
  next?: string | null;
  /** True while the sibling password submit is mid-request. */
  disabled?: boolean;
  /** Reports whether an OAuth redirect is in flight (form-wide disable). */
  onPendingChange?: (pending: boolean) => void;
}) {
  const [pendingProvider, setPendingProvider] = useState<OAuthProvider | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const busy = disabled || pendingProvider !== null;

  async function start(provider: OAuthProvider) {
    if (busy) return;
    setPendingProvider(provider);
    setError(null);
    onPendingChange?.(true);
    try {
      const supabase = createClient();
      const redirectTo = new URL("/auth/callback", window.location.origin);
      if (next) {
        redirectTo.searchParams.set("next", next);
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: redirectTo.toString() },
      });
      if (error) throw error;
      // The browser is navigating to the provider; stay disabled until then.
    } catch {
      setError(initiationErrorCopy(provider));
      setPendingProvider(null);
      onPendingChange?.(false);
    }
  }

  const verb = intent === "signin" ? "Continue with" : "Sign up with";

  return (
    <div className="flex flex-col gap-3">
      <div className="relative text-center">
        <div
          className="absolute inset-x-0 top-1/2 border-t"
          aria-hidden="true"
        />
        <span className="relative bg-card px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {intent === "signin" ? "or continue with" : "or sign up with"}
        </span>
      </div>
      {error && (
        <p id="oauth-error" role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void start("google")}
        >
          <GoogleIcon />
          {verb} Google
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void start("github")}
        >
          <Github className="size-4" aria-hidden="true" />
          {verb} GitHub
        </Button>
      </div>
    </div>
  );
}
