"use client";

import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, Lock } from "lucide-react";

export type EncryptionChipState = "encrypted" | "setting-up" | "error";

const COPY: Record<EncryptionChipState, string> = {
  encrypted: "Encrypted",
  "setting-up": "Setting up…",
  error: "Can't decrypt",
};

/**
 * The channel's encryption chip: one honest word about the state of the
 * local MLS group. Purely presentational — the caller derives the state
 * from the workspace pipeline, so this component never guesses. The state
 * is spelled out in text, never carried by colour alone.
 */
export function EncryptionStatus({
  state,
  className,
}: {
  state: EncryptionChipState;
  className?: string;
}) {
  return (
    <Badge
      variant={state === "encrypted" ? "secondary" : "outline"}
      className={className}
    >
      {state === "encrypted" ? (
        <Lock aria-hidden="true" className="size-3" />
      ) : state === "setting-up" ? (
        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
      ) : (
        <AlertTriangle aria-hidden="true" className="size-3" />
      )}
      <span>{COPY[state]}</span>
    </Badge>
  );
}
