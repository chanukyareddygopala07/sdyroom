"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

/**
 * A labelled password input with a visibility toggle. The button swaps the
 * input's `type` and announces its state through `aria-pressed` plus a
 * changing accessible name ("Show password" / "Hide password"), so the
 * control reads correctly without sight of the screen. Everything else —
 * id, autoComplete, invalid/described-by wiring — is passed straight
 * through to the input, which keeps the ids the accessibility and e2e
 * suites already address.
 */
export function PasswordField({
  id,
  label,
  error,
  errorId,
  ...inputProps
}: {
  id: string;
  label: string;
  error?: boolean;
  errorId?: string;
} & Omit<
  React.ComponentPropsWithoutRef<typeof Input>,
  "type" | "id" | "aria-invalid" | "aria-describedby"
>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          {...inputProps}
          id={id}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
