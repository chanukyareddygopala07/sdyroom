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

export function SignUpForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const router = useRouter();

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPending) return;
    const supabase = createClient();
    setIsPending(true);
    setError(null);

    if (password !== repeatPassword) {
      setError("Passwords do not match");
      setIsPending(false);
      return;
    }

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/rooms`,
        },
      });
      if (error) throw error;
      // Auto-confirm creates the session immediately, so the new user goes
      // straight to onboarding; otherwise we wait for the email confirmation.
      router.push(data.session ? "/onboarding" : "/auth/sign-up-success");
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
    } finally {
      setIsPending(false);
    }
  };

  const errorId = "sign-up-error";

  return (
    <div className={cn("flex w-full flex-col gap-4", className)} {...props}>
      <Card className="border bg-card shadow-sm">
        <CardHeader className="text-center">
          <CardTitle as="h1" className="text-2xl">
            Create your SdyRoom account
          </CardTitle>
          <CardDescription>
            Join a study room, build your focus, and study together.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignUp}>
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
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
              </div>
              <PasswordField
                id="password"
                label="Password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={Boolean(error)}
                errorId={errorId}
              />
              <PasswordField
                id="repeat-password"
                label="Repeat Password"
                required
                autoComplete="new-password"
                value={repeatPassword}
                onChange={(e) => setRepeatPassword(e.target.value)}
                error={Boolean(error)}
                errorId={errorId}
              />
              {error && (
                <p id={errorId} role="alert" className="text-sm text-error">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full bg-gradient-brand"
                disabled={isPending}
              >
                {isPending ? "Creating account…" : "Create account"}
              </Button>
              <OAuthButtons
                intent="signup"
                disabled={isPending}
                onPendingChange={setIsPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>

      {/* GitHub-style switching panel: one clear route to the other flow. */}
      <div className="rounded-xl border bg-card px-4 py-3 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/auth/login"
          className="font-medium text-foreground underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
