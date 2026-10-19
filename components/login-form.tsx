"use client";

import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Renders a fixed, reviewed copy line for every sign-in failure instead of
 * the raw provider message (PR 21): Supabase errors can echo addresses or
 * internals, and the alert text is user-facing product copy. Only known
 * conditions get tailored wording; everything else is generic.
 */
function loginErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Something went wrong. Please try again.";
  }
  const message = error.message.toLowerCase();
  if (message.includes("invalid login credentials")) {
    return "Email or password is incorrect.";
  }
  if (message.includes("email not confirmed")) {
    return "Check your inbox for a confirmation link, then try again.";
  }
  if (message.includes("too many requests") || message.includes("rate limit")) {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (message.includes("fetch") || message.includes("network")) {
    return "We could not reach the server. Check your connection and try again.";
  }
  return "Something went wrong. Please try again.";
}

export function LoginForm({
  className,
  next = null,
  oauthError = false,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  /** Server-validated site-internal path to resume after OAuth returns. */
  next?: string | null;
  /** True when the OAuth callback bounced back with a provider failure. */
  oauthError?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPending) return;
    const supabase = createClient();
    setIsPending(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      // An active session lands in room discovery (or the validated
      // resume target, when the login page supplied one).
      router.push(next ?? "/rooms");
    } catch (error: unknown) {
      setError(loginErrorMessage(error));
    } finally {
      setIsPending(false);
    }
  };

  const errorId = "login-error";
  const hasError = error !== null || oauthError;

  return (
    <div className={cn("flex w-full flex-col gap-4", className)} {...props}>
      <Card className="border bg-card shadow-sm">
        <CardHeader className="text-center">
          <CardTitle as="h1" className="text-2xl">
            Welcome back
          </CardTitle>
          <CardDescription>Sign in to return to your study rooms.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin}>
            <div className="flex flex-col gap-5">
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="m@example.com"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={hasError ? true : undefined}
                  aria-describedby={hasError ? errorId : undefined}
                />
              </div>
              <PasswordField
                id="password"
                label="Password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={hasError}
                errorId={errorId}
              />
              <div className="text-right">
                <Link
                  href="/auth/forgot-password"
                  className="text-sm underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Forgot your password?
                </Link>
              </div>
              {error && (
                <p id={errorId} role="alert" className="text-sm text-error">
                  {error}
                </p>
              )}
              {oauthError && !error && (
                <p id={errorId} role="alert" className="text-sm text-error">
                  Sign-in was cancelled or could not be completed. Try again,
                  or use your email and password.
                </p>
              )}
              <Button
                type="submit"
                className="w-full bg-gradient-brand"
                disabled={isPending}
              >
                {isPending ? "Signing in…" : "Sign in"}
              </Button>
              <OAuthButtons
                intent="signin"
                next={next}
                disabled={isPending}
                onPendingChange={setIsPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>

      {/* GitHub-style switching panel: one clear route to the other flow. */}
      <div className="rounded-xl border bg-card px-4 py-3 text-center text-sm text-muted-foreground">
        New to SdyRoom?{" "}
        <Link
          href="/auth/sign-up"
          className="font-medium text-foreground underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          Create an account
        </Link>
      </div>
    </div>
  );
}
