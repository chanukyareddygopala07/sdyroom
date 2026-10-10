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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PublicRoom } from "@/lib/rooms/types";
import {
  CAPACITY_MAX,
  CAPACITY_MIN,
  EXAM_TRACK_MAX,
  LANGUAGE_MAX,
  ROOM_NAME_MAX,
  SHARED_GOAL_MAX,
  SUBJECT_MAX,
  updateRoomSchema,
} from "@/lib/validation/rooms";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ApiIssue = {
  path: string;
  message: string;
};

type ApiResponseBody = {
  room?: PublicRoom;
  error?: { code?: string; message?: string; issues?: ApiIssue[] };
};

/** The editable draft, seeded from the server's row. */
type Draft = {
  name: string;
  shared_goal: string;
  exam_track: string;
  subject: string;
  language: string;
  capacity: string;
  status: string;
};

function draftFrom(room: PublicRoom): Draft {
  return {
    name: room.name,
    shared_goal: room.shared_goal ?? "",
    exam_track: room.exam_track ?? "",
    subject: room.subject ?? "",
    language: room.language ?? "",
    capacity: String(room.capacity),
    status: room.status === "closed" ? "closed" : "open",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.shared_goal === b.shared_goal &&
    a.exam_track === b.exam_track &&
    a.subject === b.subject &&
    a.language === b.language &&
    a.capacity === b.capacity &&
    a.status === b.status
  );
}

function toFieldErrors(issues: ApiIssue[]): Record<string, string> {
  return issues.reduce<Record<string, string>>((acc, issue) => {
    if (!acc[issue.path]) {
      acc[issue.path] = issue.message;
    }
    return acc;
  }, {});
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-sm text-error" role="alert">
      {message}
    </p>
  );
}

/**
 * The owner's edit form: the mutable field set only — never `owner_id`,
 * `visibility` or timestamps, which the strict server schema and the absent
 * column grants refuse independently of this UI.
 *
 * Client validation reuses `updateRoomSchema` itself, so the browser and the
 * server agree on limits by construction. The payload always carries the
 * full editable set (blank text becomes `null`, i.e. "clear"), and after a
 * successful save the *response* — not the local draft — becomes the new
 * baseline, so what you see is what the database actually stored.
 */
export function RoomSettingsForm({
  room,
  memberCount,
  className,
  ...props
}: { room: PublicRoom; memberCount: number | null } & React.ComponentPropsWithoutRef<"div">) {
  const router = useRouter();
  const [baseline, setBaseline] = useState<Draft>(() => draftFrom(room));
  const [draft, setDraft] = useState<Draft>(() => draftFrom(room));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const dirty = !sameDraft(draft, baseline);

  // Unsaved-change guard: the browser's own prompt while anything differs
  // from the last state the server confirmed.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSavedMessage(null);
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const handleCancel = () => {
    if (
      dirty &&
      !window.confirm("Discard your unsaved changes to this room?")
    ) {
      return;
    }
    setDraft(baseline);
    setFieldErrors({});
    setFormError(null);
    setSavedMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSavedMessage(null);
    setFieldErrors({});

    const payload = {
      name: draft.name,
      shared_goal: draft.shared_goal.trim() === "" ? null : draft.shared_goal,
      exam_track: draft.exam_track.trim() === "" ? null : draft.exam_track,
      subject: draft.subject.trim() === "" ? null : draft.subject,
      language: draft.language.trim() === "" ? null : draft.language,
      capacity: draft.capacity,
      status: draft.status,
    };

    const parsed = updateRoomSchema.safeParse(payload);
    if (!parsed.success) {
      // Mirror the server's issue shape (zod 4 exposes `path: PropertyKey[]`).
      setFieldErrors(
        toFieldErrors(
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        ),
      );
      setFormError("Check the highlighted fields and try again.");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = (await response.json().catch(() => null)) as ApiResponseBody | null;

      if (response.status === 200 && body?.room) {
        // The server's row is the truth: reseed both the form and its
        // baseline from it (trimmed values, normalised nulls, applied
        // status), then refresh the server components around it.
        const saved = draftFrom(body.room);
        setBaseline(saved);
        setDraft(saved);
        setSavedMessage("Room settings saved.");
        router.refresh();
        return;
      }

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      if (response.status === 400 && body?.error?.issues) {
        setFieldErrors(toFieldErrors(body.error.issues));
        setFormError(body.error.message ?? "Check the room details and try again.");
        return;
      }

      if (response.status === 409 && body?.error?.code === "capacity_below_membership") {
        setFieldErrors({ capacity: body.error.message ?? "Capacity is too low." });
        setFormError(body.error.message ?? "Capacity is too low.");
        return;
      }

      if (response.status === 404) {
        setFormError("This room no longer exists.");
        return;
      }

      setFormError(
        body?.error?.message ?? "The room could not be updated. Please try again.",
      );
    } catch {
      setFormError("Could not reach the server. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Room details</CardTitle>
          <CardDescription>
            Visible to every member and, for public rooms, in discovery.
            Visibility itself cannot be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-5">
              <div className="grid gap-2">
                <Label htmlFor="settings-name">Room name</Label>
                <Input
                  id="settings-name"
                  name="name"
                  required
                  maxLength={ROOM_NAME_MAX}
                  value={draft.name}
                  onChange={(e) => setField("name", e.target.value)}
                />
                <FieldError message={fieldErrors.name} />
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="settings-capacity">Capacity</Label>
                  <Input
                    id="settings-capacity"
                    name="capacity"
                    type="number"
                    inputMode="numeric"
                    min={CAPACITY_MIN}
                    max={CAPACITY_MAX}
                    step={1}
                    required
                    value={draft.capacity}
                    onChange={(e) => setField("capacity", e.target.value)}
                  />
                  {memberCount !== null && (
                    <p className="text-xs text-muted-foreground">
                      {memberCount} {memberCount === 1 ? "member" : "members"} —
                      capacity can&apos;t go below this.
                    </p>
                  )}
                  <FieldError message={fieldErrors.capacity} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="settings-status">Status</Label>
                  <Select
                    id="settings-status"
                    name="status"
                    value={draft.status}
                    onChange={(e) => setField("status", e.target.value)}
                  >
                    <option value="open">Open — anyone eligible can join</option>
                    <option value="closed">
                      Closed — members only, no new joins
                    </option>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    A closed room stays in discovery with a Closed badge, and
                    its members keep chat, files, timers and goals.
                  </p>
                  <FieldError message={fieldErrors.status} />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="settings-exam_track">Exam track</Label>
                  <Input
                    id="settings-exam_track"
                    name="exam_track"
                    placeholder="JEE"
                    maxLength={EXAM_TRACK_MAX}
                    value={draft.exam_track}
                    onChange={(e) => setField("exam_track", e.target.value)}
                  />
                  <FieldError message={fieldErrors.exam_track} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="settings-subject">Subject</Label>
                  <Input
                    id="settings-subject"
                    name="subject"
                    placeholder="Mathematics"
                    maxLength={SUBJECT_MAX}
                    value={draft.subject}
                    onChange={(e) => setField("subject", e.target.value)}
                  />
                  <FieldError message={fieldErrors.subject} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="settings-language">Language</Label>
                  <Input
                    id="settings-language"
                    name="language"
                    placeholder="English"
                    maxLength={LANGUAGE_MAX}
                    value={draft.language}
                    onChange={(e) => setField("language", e.target.value)}
                  />
                  <FieldError message={fieldErrors.language} />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="settings-shared_goal">Shared goal</Label>
                <Textarea
                  id="settings-shared_goal"
                  name="shared_goal"
                  placeholder="Finish the syllabus and mock-test every Sunday."
                  maxLength={SHARED_GOAL_MAX}
                  value={draft.shared_goal}
                  onChange={(e) => setField("shared_goal", e.target.value)}
                />
                <FieldError message={fieldErrors.shared_goal} />
              </div>

              {formError && (
                <p className="text-sm text-error" role="alert">
                  {formError}
                </p>
              )}
              {savedMessage && !formError && (
                <p className="text-sm text-green-600" role="status">
                  {savedMessage}
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={isSaving || !dirty}>
                  {isSaving ? "Saving..." : "Save changes"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
