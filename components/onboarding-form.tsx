"use client";

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
import { cn } from "@/lib/utils";
import {
  ALIAS_MAX_LENGTH,
  onboardingSchema,
} from "@/lib/validation/profile";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function OnboardingForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const parsed = onboardingSchema.safeParse({ alias });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your study alias.");
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: parsed.data.alias }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;

      if (response.ok) {
        router.push("/rooms");
        router.refresh();
        return;
      }

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      setError(
        body?.error?.message ??
          "Your study alias could not be saved. Please try again.",
      );
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Choose a study alias</CardTitle>
          <CardDescription>
            This alias is how you appear in every room you join. It must be
            unique and can be changed later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              <div className="grid gap-2">
                <Label htmlFor="alias">Study alias</Label>
                <Input
                  id="alias"
                  name="alias"
                  placeholder="examnerd"
                  required
                  autoFocus
                  autoComplete="off"
                  maxLength={ALIAS_MAX_LENGTH}
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Up to {ALIAS_MAX_LENGTH} characters: letters, numbers,
                  spaces, hyphens or underscores.
                </p>
              </div>
              {error && (
                <p className="text-sm text-red-500" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Saving..." : "Continue to rooms"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
