"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StudyGoal } from "@/lib/goals/types";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Minutes allowed by the `target_seconds` CHECK in 0003 (60..86400s). */
const TARGET_MINUTES_MIN = 1;
const TARGET_MINUTES_MAX = 1440;
const TARGET_COUNT_MIN = 1;
const TARGET_COUNT_MAX = 10000;

type GoalsApiResponse = {
  goal?: StudyGoal;
  goals?: StudyGoal[];
  error?: { message?: string };
};

/**
 * The caller's own goals for one room: create, complete or reopen, delete.
 *
 * Every write goes through the API and only the returned row is trusted —
 * RLS decides whose goal it is, and a 404 (someone else's id, or a goal that
 * is already gone) simply leaves the list untouched rather than pretending
 * the deletion happened.
 */
export function GoalsPanel({
  roomId,
  initialGoals,
}: {
  roomId: string;
  initialGoals: StudyGoal[];
}) {
  const router = useRouter();
  const [goals, setGoals] = useState<StudyGoal[]>(initialGoals);
  const [title, setTitle] = useState("");
  const [targetMinutes, setTargetMinutes] = useState("");
  const [targetCount, setTargetCount] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingGoalId, setPendingGoalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readError = async (response: Response): Promise<string | null> => {
    const body = (await response.json().catch(() => null)) as GoalsApiResponse | null;
    return body?.error?.message ?? null;
  };

  const createGoal = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const minutes = targetMinutes.trim();
    const count = targetCount.trim();
    const minutesValue = minutes === "" ? null : Number(minutes);
    const countValue = count === "" ? null : Number(count);

    if (
      minutesValue !== null &&
      (!Number.isFinite(minutesValue) ||
        minutesValue < TARGET_MINUTES_MIN ||
        minutesValue > TARGET_MINUTES_MAX)
    ) {
      setError(
        `Target time must be between ${TARGET_MINUTES_MIN} and ${TARGET_MINUTES_MAX} minutes.`,
      );
      return;
    }
    if (
      countValue !== null &&
      (!Number.isFinite(countValue) ||
        !Number.isInteger(countValue) ||
        countValue < TARGET_COUNT_MIN ||
        countValue > TARGET_COUNT_MAX)
    ) {
      setError(
        `Target count must be a whole number between ${TARGET_COUNT_MIN} and ${TARGET_COUNT_MAX}.`,
      );
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/rooms/${roomId}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          ...(minutesValue === null
            ? {}
            : { target_seconds: minutesValue * 60 }),
          ...(countValue === null ? {} : { target_count: countValue }),
        }),
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as GoalsApiResponse | null;
      const created = body?.goal;

      if (!response.ok || !created) {
        setError(
          body?.error?.message ??
            "The goal could not be saved. Please try again.",
        );
        return;
      }

      setGoals((current) => [created, ...current]);
      setTitle("");
      setTargetMinutes("");
      setTargetCount("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = async (goal: StudyGoal) => {
    setPendingGoalId(goal.id);
    setError(null);

    try {
      const response = await fetch(`/api/goals/${goal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: goal.status === "active" ? "completed" : "active",
        }),
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as GoalsApiResponse | null;

      if (!response.ok || !body?.goal) {
        setError(
          body?.error?.message ?? "The goal could not be updated. Please try again.",
        );
        return;
      }

      const updated = body.goal;
      setGoals((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setPendingGoalId(null);
    }
  };

  const removeGoal = async (goal: StudyGoal) => {
    setPendingGoalId(goal.id);
    setError(null);

    try {
      const response = await fetch(`/api/goals/${goal.id}`, {
        method: "DELETE",
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      if (!response.ok) {
        setError(
          (await readError(response).catch(() => null)) ??
            "The goal could not be deleted. Please try again.",
        );
        return;
      }

      setGoals((current) => current.filter((item) => item.id !== goal.id));
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setPendingGoalId(null);
    }
  };

  const describeTarget = (goal: StudyGoal): string | null => {
    const parts: string[] = [];
    if (goal.target_seconds !== null) {
      parts.push(`${Math.round(goal.target_seconds / 60)} min`);
    }
    if (goal.target_count !== null) {
      parts.push(`${goal.target_count} ×`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border p-5"
      aria-label="My goals in this room"
    >
      <h2 className="text-lg font-semibold">My goals</h2>

      <form onSubmit={(event) => void createGoal(event)} className="flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${roomId}-goal-title`}>Goal title</Label>
          <Input
            id={`${roomId}-goal-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Finish chapter 4"
            maxLength={120}
            required
            aria-invalid={error !== null || undefined}
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor={`${roomId}-goal-minutes`}>
              Target time in minutes
            </Label>
            <Input
              id={`${roomId}-goal-minutes`}
              type="number"
              inputMode="numeric"
              min={TARGET_MINUTES_MIN}
              max={TARGET_MINUTES_MAX}
              value={targetMinutes}
              onChange={(event) => setTargetMinutes(event.target.value)}
              placeholder="90 (optional)"
            />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor={`${roomId}-goal-count`}>Target count</Label>
            <Input
              id={`${roomId}-goal-count`}
              type="number"
              inputMode="numeric"
              min={TARGET_COUNT_MIN}
              max={TARGET_COUNT_MAX}
              value={targetCount}
              onChange={(event) => setTargetCount(event.target.value)}
              placeholder="3 (optional)"
            />
          </div>
          <Button type="submit" disabled={busy} className="sm:flex-none">
            {busy ? "Saving…" : "Add goal"}
          </Button>
        </div>
      </form>

      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No goals yet. Add one above — only you can see it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {goals.map((goal) => {
            const target = describeTarget(goal);
            const isPending = pendingGoalId === goal.id;
            return (
              <li
                key={goal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <span className="flex flex-col gap-1">
                  <span
                    className={
                      goal.status === "completed"
                        ? "text-sm text-muted-foreground line-through"
                        : "text-sm font-medium"
                    }
                  >
                    {goal.title}
                  </span>
                  {target && (
                    <span className="text-xs text-muted-foreground">{target}</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={goal.status === "completed" ? "secondary" : "default"}>
                    {goal.status}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => void updateStatus(goal)}
                  >
                    {goal.status === "active" ? "Complete" : "Reopen"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    aria-label={`Delete goal ${goal.title}`}
                    onClick={() => void removeGoal(goal)}
                  >
                    Delete
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
