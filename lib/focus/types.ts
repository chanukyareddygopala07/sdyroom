export type FocusSessionState = "running" | "paused" | "completed" | "expired";

/**
 * Exactly the columns a client is allowed to see. The table deliberately has
 * no starter column (see 0003), and this list is spelled out rather than
 * `SELECT *` so any future private column cannot leak into a response either.
 */
export type FocusSession = {
  id: string;
  room_id: string;
  state: FocusSessionState;
  duration_seconds: number;
  started_at: string;
  ends_at: string;
  paused_at: string | null;
  paused_seconds: number;
  ended_at: string | null;
};

export const FOCUS_SESSION_COLUMNS =
  "id, room_id, state, duration_seconds, started_at, ends_at, paused_at, paused_seconds, ended_at";

const FOCUS_STATES: readonly FocusSessionState[] = [
  "running",
  "paused",
  "completed",
  "expired",
];

export function isFocusSessionState(value: unknown): value is FocusSessionState {
  return (
    typeof value === "string" &&
    (FOCUS_STATES as readonly string[]).includes(value)
  );
}

/** Successful outcomes of a session control RPC. */
export type FocusAction =
  | "started"
  | "already_active"
  | "paused"
  | "resumed"
  | "completed";

export type ViewerRole = "owner" | "student";

export const FOCUS_HISTORY_LIMIT = 10;
