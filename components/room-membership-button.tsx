"use client";

import { Button } from "@/components/ui/button";
import type { ViewerMembership } from "@/lib/rooms/types";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RoomMembershipButtonProps = {
  roomId: string;
  roomName: string;
  viewerMembership: ViewerMembership;
  isFull: boolean;
  isClosed: boolean;
};

/**
 * Join / leave control for a public room.
 *
 * The server is the source of truth: every click posts to the membership
 * endpoint and `router.refresh()` re-renders the list, so the button a
 * student sees after a refresh always matches the database. Full and closed
 * rooms explain themselves up front, and a race that loses (someone else took
 * the last seat) is reported from the 409 the API returns.
 */
export function RoomMembershipButton({
  roomId,
  roomName,
  viewerMembership,
  isFull,
  isClosed,
}: RoomMembershipButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "join" | "leave") => {
    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/rooms/${roomId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        setError(
          body?.error?.message ??
            (action === "join"
              ? "The room could not be joined. Please try again."
              : "You could not leave this room. Please try again."),
        );
        // The room may have changed underneath us (someone took the last
        // seat, the owner closed it): re-render so the card tells the truth.
        router.refresh();
        return;
      }

      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setIsPending(false);
    }
  };

  let control: React.ReactNode;
  if (viewerMembership === "owner") {
    control = (
      <p className="text-xs text-muted-foreground">You own this room.</p>
    );
  } else if (viewerMembership === "member") {
    control = (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        aria-label={`Leave ${roomName}`}
        onClick={() => void act("leave")}
      >
        {isPending ? "Leaving..." : "Leave room"}
      </Button>
    );
  } else if (isClosed) {
    control = <p className="text-xs text-muted-foreground">Room is closed.</p>;
  } else if (isFull) {
    control = <p className="text-xs text-muted-foreground">Room is full.</p>;
  } else {
    control = (
      <Button
        type="button"
        size="sm"
        disabled={isPending}
        aria-label={`Join ${roomName}`}
        onClick={() => void act("join")}
      >
        {isPending ? "Joining..." : "Join room"}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {control}
      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
