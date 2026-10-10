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
import {
  CAPACITY_DEFAULT,
  CAPACITY_MAX,
  CAPACITY_MIN,
  EXAM_TRACK_MAX,
  LANGUAGE_MAX,
  ROOM_NAME_MAX,
  SHARED_GOAL_MAX,
  SUBJECT_MAX,
} from "@/lib/validation/rooms";
import { useRouter } from "next/navigation";
import { useState } from "react";

type ApiIssue = {
  path: string;
  message: string;
};

type ApiResponseBody = {
  room?: { id?: unknown };
  error?: { code?: string; message?: string; issues?: ApiIssue[] };
};

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
    <p className="text-sm text-red-500" role="alert">
      {message}
    </p>
  );
}

export function RoomCreateForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(String(CAPACITY_DEFAULT));
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [examTrack, setExamTrack] = useState("");
  const [subject, setSubject] = useState("");
  const [language, setLanguage] = useState("");
  const [sharedGoal, setSharedGoal] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setFieldErrors({});
    setFormError(null);

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          capacity,
          visibility,
          exam_track: examTrack,
          subject,
          language,
          shared_goal: sharedGoal,
        }),
      });

      const body = (await response.json().catch(() => null)) as ApiResponseBody | null;

      if (response.status === 201) {
        // Enter the workspace directly: it is only reachable by URL, and a
        // private room never shows up in discovery for anyone to click later.
        const roomId = body?.room?.id;
        router.push(typeof roomId === "string" ? `/rooms/${roomId}` : "/rooms");
        router.refresh();
        return;
      }

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      if (response.status === 403 && body?.error?.code === "onboarding_required") {
        router.push("/onboarding");
        return;
      }

      if (response.status === 400 && body?.error?.issues) {
        setFieldErrors(toFieldErrors(body.error.issues));
        setFormError(body.error.message ?? "Check the room details and try again.");
        return;
      }

      setFormError(
        body?.error?.message ?? "The room could not be created. Please try again.",
      );
    } catch {
      setFormError("Could not reach the server. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-2xl">New study room</CardTitle>
          <CardDescription>
            You become the owner. Public rooms appear in discovery immediately;
            private rooms stay unlisted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-5">
              <div className="grid gap-2">
                <Label htmlFor="name">Room name</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="Calculus Study Room"
                  required
                  maxLength={ROOM_NAME_MAX}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <FieldError message={fieldErrors.name} />
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="capacity">Capacity</Label>
                  <Input
                    id="capacity"
                    name="capacity"
                    type="number"
                    inputMode="numeric"
                    min={CAPACITY_MIN}
                    max={CAPACITY_MAX}
                    step={1}
                    required
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                  <FieldError message={fieldErrors.capacity} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="visibility">Visibility</Label>
                  <Select
                    id="visibility"
                    name="visibility"
                    value={visibility}
                    onChange={(e) =>
                      setVisibility(e.target.value as "public" | "private")
                    }
                  >
                    <option value="public">Public — listed in discovery</option>
                    <option value="private">Private — unlisted</option>
                  </Select>
                  <FieldError message={fieldErrors.visibility} />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="exam_track">Exam track</Label>
                  <Input
                    id="exam_track"
                    name="exam_track"
                    placeholder="JEE"
                    maxLength={EXAM_TRACK_MAX}
                    value={examTrack}
                    onChange={(e) => setExamTrack(e.target.value)}
                  />
                  <FieldError message={fieldErrors.exam_track} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    name="subject"
                    placeholder="Mathematics"
                    maxLength={SUBJECT_MAX}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                  <FieldError message={fieldErrors.subject} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="language">Language</Label>
                  <Input
                    id="language"
                    name="language"
                    placeholder="English"
                    maxLength={LANGUAGE_MAX}
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  />
                  <FieldError message={fieldErrors.language} />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="shared_goal">Shared goal</Label>
                <Textarea
                  id="shared_goal"
                  name="shared_goal"
                  placeholder="Finish the syllabus and mock-test every Sunday."
                  maxLength={SHARED_GOAL_MAX}
                  value={sharedGoal}
                  onChange={(e) => setSharedGoal(e.target.value)}
                />
                <FieldError message={fieldErrors.shared_goal} />
              </div>

              {formError && (
                <p className="text-sm text-red-500" role="alert">
                  {formError}
                </p>
              )}

              <div className="flex gap-3">
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? "Creating room..." : "Create room"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push("/rooms")}
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
