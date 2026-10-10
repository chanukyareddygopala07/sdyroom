"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type {
  NotificationPrefValue,
  NotificationPrefs,
} from "@/lib/notifications/types";
import { PREF_VALUES } from "@/lib/notifications/types";
import { cn } from "@/lib/utils";

type PatchResponse = {
  prefs?: NotificationPrefs;
  error?: { message?: string };
};

const CATEGORY_OPTIONS: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  {
    key: "invite",
    label: "Invitations",
    description: "Room invitations addressed to your alias.",
  },
  {
    key: "moderation",
    label: "Moderation",
    description: "Mutes, removals, and the outcome of reports you filed.",
  },
  {
    key: "resource",
    label: "Resources",
    description: "When a file you uploaded finishes processing.",
  },
  {
    key: "ai",
    label: "AI tasks",
    description: "When an AI task you started completes.",
  },
];

const VALUE_LABELS: Record<NotificationPrefValue, string> = {
  all: "All of these",
  mentions_and_invites: "Invites only",
  none: "None",
};

/**
 * Per-category preference controls. PR 20's settings page does not exist
 * yet, so this form is mounted on the notifications inbox and is written to
 * be absorbed unchanged: it owns no data, receives the merged record, and
 * PATCHes the partial body the API documents. Every select is closed by
 * construction (the enum is the option list), so the only client-side
 * "validation" is the save state itself.
 */
export function PreferencesForm({
  initialPrefs,
}: {
  initialPrefs: NotificationPrefs;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<NotificationPrefs>(initialPrefs);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/profile/notification-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prefs: {
            invite: prefs.invite,
            moderation: prefs.moderation,
            resource: prefs.resource,
            ai: prefs.ai,
          },
        }),
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | PatchResponse
        | null;

      if (!response.ok) {
        setError(
          body?.error?.message ?? "Preferences could not be saved. Please try again.",
        );
        return;
      }

      if (body?.prefs) {
        setPrefs(body.prefs);
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Preferences could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification preferences</CardTitle>
        <CardDescription>
          Choose what creates a notification. Preferences apply to the next
          event immediately — nothing already in your inbox changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {CATEGORY_OPTIONS.map((option) => (
          <div key={option.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`pref-${option.key}`}>{option.label}</Label>
            <Select
              id={`pref-${option.key}`}
              value={prefs[option.key] ?? "all"}
              onChange={(event) => {
                setPrefs((current) => ({
                  ...current,
                  [option.key]: event.target.value as NotificationPrefValue,
                }));
                setSaved(false);
              }}
            >
              {PREF_VALUES.map((value) => (
                <option key={value} value={value}>
                  {VALUE_LABELS[value]}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">{option.description}</p>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save preferences"}
          </Button>
          <p
            role="status"
            aria-live="polite"
            className={cn("text-sm text-muted-foreground", saved && "text-foreground")}
            data-testid="prefs-status"
          >
            {error ? error : saved ? "Preferences saved." : ""}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
