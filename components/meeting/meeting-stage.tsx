"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MeetingRoomView } from "./meeting-room-view";

type MeetingCredentials = {
  token: string;
  url: string;
  room: string;
  identity: string;
  canPublishMic: boolean;
};

type Phase = "idle" | "requesting" | "connecting" | "live" | "error";

/**
 * Narrows the token endpoint's 200 body. The server is ours, but a proxy or
 * captive portal can answer instead — anything unexpected becomes the same
 * retryable error rather than a broken LiveKit connection attempt.
 */
function readCredentials(payload: unknown): MeetingCredentials | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    typeof record.url !== "string" ||
    typeof record.room !== "string" ||
    typeof record.identity !== "string" ||
    typeof record.can_publish_mic !== "boolean"
  ) {
    return null;
  }
  return {
    token: record.token,
    url: record.url,
    room: record.room,
    identity: record.identity,
    canPublishMic: record.can_publish_mic,
  };
}

function joinErrorMessage(code: string | undefined, status: number): string {
  switch (code) {
    case "meeting_unavailable":
      return "Live meetings aren't set up on this server yet.";
    case "not_found":
      return "You no longer have access to this room.";
    case "unauthenticated":
      return "Your session expired — sign in again to join the meeting.";
    case "rate_limited":
      return "Too many join attempts — wait a minute and try again.";
    case "validation":
      return "That room id is not valid.";
    case "meeting_token_failed":
    default:
      return status >= 500
        ? "The meeting could not be started. Please try again."
        : "We couldn't start the meeting. Please try again.";
  }
}

/**
 * The meeting half of the room workspace: join card → connecting → live, or
 * back to the join card when the call ends on its own. Every join re-mints a
 * short-lived token through `POST /api/rooms/[id]/meeting/token`, which
 * re-proves room membership server-side — this component never assumes the
 * member still has a seat. The stage owns no media itself; the connected
 * view is `MeetingRoomView`.
 */
export function MeetingStage({
  roomId,
  meetingConfigured,
  onLeave,
}: {
  roomId: string;
  meetingConfigured: boolean;
  onLeave: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [credentials, setCredentials] =
    useState<MeetingCredentials | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const join = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("requesting");
    setErrorMessage(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/meeting/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const code = (
          payload as { error?: { code?: string } } | null
        )?.error?.code;
        throw new Error(joinErrorMessage(code, response.status));
      }
      const next = readCredentials(payload);
      if (!next) {
        throw new Error(
          "The server sent an unexpected meeting response. Please try again.",
        );
      }
      setCredentials(next);
      setPhase("connecting");
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setErrorMessage(
        error instanceof TypeError
          ? "We couldn't reach the server. Check your connection and try again."
          : error instanceof Error
            ? error.message
            : "We couldn't start the meeting. Please try again.",
      );
      setPhase("error");
    }
  }, [roomId]);

  if (!meetingConfigured) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <Video
          aria-hidden="true"
          className="mx-auto mb-3 size-8 text-muted-foreground"
        />
        <h2 className="text-base font-semibold">Live meetings are unavailable</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          This server doesn&apos;t have live meetings set up yet. You can keep
          studying together with the focus timer and chat.
        </p>
        <Button type="button" variant="outline" className="mt-4" onClick={onLeave}>
          Back to studying
        </Button>
      </div>
    );
  }

  if (credentials && (phase === "connecting" || phase === "live")) {
    return (
      <MeetingRoomView
        url={credentials.url}
        token={credentials.token}
        canPublishMic={credentials.canPublishMic}
        onConnected={() => setPhase("live")}
        onDisconnected={(message) => {
          setCredentials(null);
          setNotice(message);
          setPhase("idle");
        }}
        onError={(message) => {
          setCredentials(null);
          setErrorMessage(message);
          setPhase("error");
        }}
        onLeave={onLeave}
      />
    );
  }

  if (phase === "error") {
    return (
      <div className="rounded-xl border bg-card p-6 text-center" role="alert">
        <h2 className="text-base font-semibold">The meeting didn&apos;t start</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {errorMessage}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={() => void join()}>
            Try again
          </Button>
          <Button type="button" variant="outline" onClick={onLeave}>
            Back to studying
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 text-center">
      <h2 className="text-base font-semibold">Live meeting</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Study together with video, voice and screen sharing. Your camera and
        microphone stay off until you turn them on.
      </p>
      {notice ? (
        <p role="status" className="mt-3 text-sm text-foreground">
          {notice}
        </p>
      ) : null}
      <Button
        type="button"
        className="mt-4"
        disabled={phase === "requesting"}
        onClick={() => void join()}
      >
        {phase === "requesting" ? "Joining…" : "Join meeting"}
      </Button>
    </div>
  );
}
