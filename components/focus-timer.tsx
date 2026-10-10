"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { publishStudying } from "@/lib/focus/studying-store";
import type {
  FocusSession,
  FocusSessionState,
  ViewerRole,
} from "@/lib/focus/types";
import { createClient } from "@/lib/supabase/client";
import { FOCUS_DURATION_PRESETS } from "@/lib/validation/focus";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/** A missed realtime event can only delay a render by this long. */
const POLL_INTERVAL_MS = 20000;

type SyncState = "connecting" | "live" | "reconnecting";

/**
 * The browser's own verdict on the network. The `offline`/`online` events it
 * drives land the moment connectivity changes, while the socket's error and
 * a failed poll can lag by tens of seconds — so the sync indicator follows
 * them before any stale callback can speak.
 */
function browserIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

type WorkspaceSnapshot = {
  session: FocusSession | null;
  history: FocusSession[];
  viewer_role: ViewerRole;
  server_now_ms: number;
};

const stateBadge: Record<FocusSessionState, { label: string; variant: "default" | "secondary" | "outline" }> = {
  running: { label: "running", variant: "default" },
  paused: { label: "paused", variant: "secondary" },
  completed: { label: "completed", variant: "outline" },
  expired: { label: "expired", variant: "outline" },
};

const historyDateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function formatClock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

function formatEndedAt(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : historyDateFormat.format(date);
}

/**
 * Shared focus timer for a study room.
 *
 * The server clock wins: every read of the workspace carries `server_now_ms`,
 * the difference from the local clock is remembered as an offset, and the
 * countdown is derived from that — so a client with a wrong clock still shows
 * the same remaining time as everyone else, and a reconnect never restarts a
 * running session.
 *
 * Freshness comes from three directions: a `focus_sessions` change event
 * triggers an immediate re-read, the state is polled, and a re-read happens
 * when the tab regains focus — a dropped event can delay a frame, never leave
 * it stale. Reading state never mutates the timer except by persisting a
 * deadline that has already passed.
 */
export function FocusTimer({
  roomId,
  roomName,
  initialSession,
  initialHistory,
  initialRole,
  initialServerNowMs,
}: {
  roomId: string;
  roomName: string;
  initialSession: FocusSession | null;
  initialHistory: FocusSession[];
  initialRole: ViewerRole;
  initialServerNowMs: number;
}) {
  const router = useRouter();
  const [session, setSession] = useState<FocusSession | null>(initialSession);
  const [history, setHistory] = useState<FocusSession[]>(initialHistory);
  const [viewerRole, setViewerRole] = useState<ViewerRole>(initialRole);
  const [sync, setSync] = useState<SyncState>("connecting");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number>(
    FOCUS_DURATION_PRESETS[0],
  );

  /**
   * The display clock, in server milliseconds: seeded from the snapshot the
   * page rendered with, then advanced once a second from the real clock plus
   * the server-minus-local offset. Both the real clock and the offset are
   * touched only from effects and handlers — render stays pure.
   */
  const [nowMs, setNowMs] = useState(initialServerNowMs);
  const offsetRef = useRef(0);
  const expiryHandledRef = useRef(false);
  /**
   * The channel has acknowledged its join; only then may the UI say "Live".
   * A successful read proves the HTTP path, not that frames are deliverable.
   */
  const subscribedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/rooms/${roomId}/workspace`, {
        cache: "no-store",
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | (WorkspaceSnapshot & { error?: unknown })
        | null;

      if (!response.ok || !body || !("server_now_ms" in body)) {
        throw new Error("workspace unavailable");
      }

      offsetRef.current = body.server_now_ms - Date.now();
      setSession(body.session);
      setHistory(body.history);
      setViewerRole(body.viewer_role);
      // A read only proves the HTTP path. "Live" still needs an
      // acknowledged subscription, and a response that resolved while the
      // network was already gone must not overrule the offline indication.
      if (!browserIsOffline() && subscribedRef.current) {
        setSync("live");
      }
      setError(null);
    } catch {
      // Keep showing the last snapshot; the next poll retries.
      setSync((current) => (current === "live" ? "reconnecting" : current));
    }
  }, [roomId, router]);

  // The browser knows first: `offline`/`online` fire the moment connectivity
  // changes, while the socket surfaces its own error only after rejoin
  // timeouts. The indicator follows those events directly; the socket itself
  // is reconnected and re-subscribed by the Supabase client.
  useEffect(() => {
    const onOffline = () => setSync("reconnecting");
    const onOnline = () => setSync("connecting");

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Realtime: one change event is enough to re-read the authoritative state.
  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // The join payload is built when the channel subscribes, and the server
    // registers the change filter under the JWT claims it saw there — so the
    // session token has to be on the client before the join goes out, or the
    // registration happens as `anon` and is rejected.
    //
    // `wait: true` makes the server hold the join reply until the filter is
    // actually registered: `SUBSCRIBED` — the "Live" badge — then means
    // frames will be delivered, instead of landing in the seconds before an
    // unconfirmed registration completes, which are silently dropped.
    void supabase.realtime
      .setAuth()
      .then(() => {
        if (disposed) return;
        channel = supabase
          .channel(`focus-${roomId}`, {
            config: { postgres_changes_options: { wait: true } },
          })
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "focus_sessions", filter: `room_id=eq.${roomId}` },
            () => {
              void refresh();
            },
          )
          .subscribe((status) => {
            if (disposed) return;
            if (status === "SUBSCRIBED") {
              // An ack that raced the connection dropping must not paint
              // "Live" over the offline indication.
              if (browserIsOffline()) {
                setSync("reconnecting");
                return;
              }
              subscribedRef.current = true;
              setSync("live");
              return;
            }
            subscribedRef.current = false;
            setSync(
              status === "CHANNEL_ERROR" || status === "TIMED_OUT"
                ? "reconnecting"
                : "connecting",
            );
          });
      })
      .catch(() => {
        // Without auth the join would be rejected server-side; say so instead
        // of pretending to be live. The 20-second poll still covers reads.
        if (!disposed) setSync("reconnecting");
      });

    return () => {
      disposed = true;
      subscribedRef.current = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [roomId, refresh]);

  // Polling plus tab focus: covers a missed event and a long backgrounded tab.
  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    const onFocus = () => {
      void refresh();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  // The display clock runs off server time: the offset is re-aligned when a
  // fresh snapshot prop arrives, and every later read of the workspace keeps
  // it current — each tick then converts the real clock to server
  // milliseconds. Nothing here touches the data itself.
  useEffect(() => {
    const align = () => {
      offsetRef.current = initialServerNowMs - Date.now();
      setNowMs(initialServerNowMs);
    };

    align();
    const interval = setInterval(
      () => setNowMs(Date.now() + offsetRef.current),
      1000,
    );
    return () => clearInterval(interval);
  }, [initialServerNowMs]);

  let remainingSeconds: number | null = null;
  if (session?.state === "running") {
    // The clock only advances once a second, so this read can lag by up to a
    // tick; clamped to the session's length, a fresh start can never show
    // more time than the session was granted.
    remainingSeconds = Math.min(
      session.duration_seconds,
      Math.max(
        0,
        Math.round((Date.parse(session.ends_at) - nowMs) / 1000),
      ),
    );
  } else if (session?.state === "paused" && session.paused_at) {
    remainingSeconds = Math.max(
      0,
      Math.round((Date.parse(session.ends_at) - Date.parse(session.paused_at)) / 1000),
    );
  }

  // A countdown that just hit zero: show it, then re-read so the database
  // records the passage (nobody's browser needs to stay open for that).
  useEffect(() => {
    if (session?.state !== "running") {
      expiryHandledRef.current = false;
      return;
    }
    if (remainingSeconds === 0 && !expiryHandledRef.current) {
      expiryHandledRef.current = true;
      void refresh();
    }
  }, [remainingSeconds, session?.state, refresh]);

  const act = async (
    action: "start" | "pause" | "resume" | "end",
  ): Promise<void> => {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/rooms/${roomId}/session/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          action === "start"
            ? JSON.stringify({ duration_seconds: durationSeconds })
            : "{}",
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        action?: string;
        session?: FocusSession;
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        // Someone else may have raced us (another start, an already-ended
        // session): re-read first so the controls show what is actually
        // true — then surface the message, since a successful read clears
        // any previous error.
        await refresh();
        setError(
          body?.error?.message ??
            "The timer could not be updated. Please try again.",
        );
        return;
      }

      if (body?.session) {
        setSession(body.session);
      }
      await refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const badge = session ? stateBadge[session.state] : null;
  const isOwner = viewerRole === "owner";
  const hasActiveSession = session?.state === "running" || session?.state === "paused";
  const durationMinutes = Math.round(durationSeconds / 60);

  // Publish the flag presence reports about this viewer. The session belongs
  // to the room (0003 keeps no starter column and only the owner controls
  // the timer), so "the room is in a focus session" is the honest statement
  // every member's client can make about itself. The cleanup publishes
  // `false` so an unmounting timer — a room switch, a sign-out — can never
  // leave a stale flag for the next room's presence track.
  useEffect(() => {
    publishStudying(hasActiveSession);
    return () => publishStudying(false);
  }, [hasActiveSession]);

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border p-5"
      aria-label="Focus timer"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Focus timer</h2>
          {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground" role="status">
          {sync === "live"
            ? "Live"
            : sync === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
        </p>
      </div>

      <div className="flex flex-col items-center gap-1 py-2">
        <p
          className="font-mono text-5xl font-semibold tabular-nums"
          aria-live="polite"
        >
          {session && remainingSeconds !== null
            ? session.state === "running" && remainingSeconds === 0
              ? "00:00"
              : formatClock(remainingSeconds)
            : "--:--"}
        </p>
        <p className="text-sm text-muted-foreground">
          {session
            ? session.state === "running" && remainingSeconds === 0
              ? "Time is up."
              : session.state === "paused"
                ? `Paused · ${Math.round(session.duration_seconds / 60)} min session`
                : `${Math.round(session.duration_seconds / 60)} min session`
            : hasActiveSession
              ? ""
              : "No session running."}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {!hasActiveSession && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">Session length:</p>
            {FOCUS_DURATION_PRESETS.map((seconds) => (
              <Button
                key={seconds}
                type="button"
                size="sm"
                variant={durationSeconds === seconds ? "default" : "outline"}
                disabled={pending}
                aria-pressed={durationSeconds === seconds}
                onClick={() => setDurationSeconds(seconds)}
              >
                {seconds / 60} min
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!hasActiveSession &&
            (isOwner ? (
              <Button
                type="button"
                disabled={pending}
                onClick={() => void act("start")}
              >
                {pending ? "Starting…" : `Start ${durationMinutes} min session`}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                The room owner starts and controls the shared timer.
              </p>
            ))}

          {hasActiveSession && isOwner && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void act(session?.state === "paused" ? "resume" : "pause")
                }
              >
                {pending
                  ? "Working…"
                  : session?.state === "paused"
                    ? "Resume"
                    : "Pause"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => void act("end")}
              >
                End session
              </Button>
            </>
          )}

          {hasActiveSession && !isOwner && (
            <p className="text-sm text-muted-foreground">
              The room owner controls this timer.
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="border-t pt-4">
        <h3 className="mb-2 text-sm font-medium">Recent sessions</h3>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Finished sessions will be listed here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {history.map((entry) => {
              const endedAt = entry.ended_at
                ? formatEndedAt(entry.ended_at)
                : null;
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Badge variant={stateBadge[entry.state].variant}>
                      {stateBadge[entry.state].label}
                    </Badge>
                    <span className="text-muted-foreground">
                      {Math.round(entry.duration_seconds / 60)} min ·{" "}
                      {entry.paused_seconds > 0
                        ? `${Math.round(entry.paused_seconds / 60)} min paused · `
                        : ""}
                      {endedAt ?? ""}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {roomName} focus timer, {session?.state ?? "idle"}.
      </p>
    </section>
  );
}
