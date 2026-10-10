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
import { useRouter } from "next/navigation";
import { useState } from "react";

type ApiResponseBody = {
  error?: { code?: string; message?: string };
};

/**
 * Danger zone: delete the room. Deliberate two-step confirmation — the
 * owner types the room's exact name before the destructive button arms, and
 * the copy says what disappears. There is no single-click path, and the
 * server re-proves ownership regardless of what this component rendered.
 *
 * After success the room (and every dependent row and object) is gone, so
 * the browser lands on the discovery list; a 404 means somebody — normally
 * this same owner in another tab — already finished the job.
 */
export function RoomDeleteControl({
  roomId,
  roomName,
}: {
  roomId: string;
  roomName: string;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmation.trim() === roomName;

  const handleDelete = async () => {
    if (!confirmed || isDeleting) return;
    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/rooms/${roomId}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => null)) as ApiResponseBody | null;

      if (response.status === 200) {
        router.push("/rooms");
        router.refresh();
        return;
      }

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      if (response.status === 404) {
        // Already deleted (another tab, or a stale page).
        router.push("/rooms");
        router.refresh();
        return;
      }

      setError(
        body?.error?.message ?? "The room could not be deleted. Please try again.",
      );
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="max-w-2xl border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Delete this room</CardTitle>
        <CardDescription>
          Deleting removes the room for everyone: memberships, chat history,
          focus sessions, goals, shared files and pending invitations. Members
          lose access immediately. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="delete-room-confirm">
              Type <span className="font-semibold">{roomName}</span> to confirm
            </Label>
            <Input
              id="delete-room-confirm"
              name="room_name_confirmation"
              placeholder={roomName}
              value={confirmation}
              onChange={(e) => {
                setConfirmation(e.target.value);
                setError(null);
              }}
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}

          <div>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={!confirmed || isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete room permanently"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
