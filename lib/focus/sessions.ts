import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isFocusSessionState,
  type FocusAction,
  type FocusSession,
  type ViewerRole,
} from "./types";

export type FocusErrorCode =
  | "not_found"
  | "not_owner"
  | "no_active_session"
  | "invalid_state"
  | "invalid";

/** Failure carrying the HTTP status the API layer returns. */
export class FocusSessionError extends Error {
  readonly code: FocusErrorCode;
  readonly status: number;

  constructor(code: FocusErrorCode, message: string, status: number) {
    super(message);
    this.name = "FocusSessionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Codes the session RPCs return on a failure, mapped onto the public
 * vocabulary. Messages are written here so SQL text, table names and
 * constraint details never reach a response body.
 *
 * A deadline that has passed is not one of them: every read and every control
 * persists expiry first, so it surfaces as `no_active_session`.
 */
const ERROR_RESULTS: Record<
  string,
  { code: FocusErrorCode; status: number; message: string }
> = {
  room_not_found: {
    code: "not_found",
    status: 404,
    message: "That room does not exist or is not available.",
  },
  not_owner: {
    code: "not_owner",
    status: 403,
    message: "Only the room owner can control this room's focus timer.",
  },
  no_active_session: {
    code: "no_active_session",
    status: 409,
    message: "There is no active focus session in this room.",
  },
  invalid_state: {
    code: "invalid_state",
    status: 409,
    message: "The focus session is not in a state that allows this.",
  },
};

const SUCCESS_RESULTS: readonly string[] = [
  "started",
  "already_active",
  "paused",
  "resumed",
  "completed",
];

export type FocusActionResult = {
  action: FocusAction;
  session: FocusSession;
};

export type FocusState = {
  session: FocusSession | null;
  viewer_role: ViewerRole;
  server_now_ms: number;
  member_count: number;
};

function envelopeOf(data: unknown): Record<string, unknown> | null {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * Parses a session row onto the exact exposed shape. Anything malformed is a
 * programming error on our side (or a schema change nobody handled), so it
 * throws instead of letting partial data reach a client.
 *
 * There is no starter column to strip — 0003 never created one — and this
 * function only ever copies the fields listed here.
 */
export function toFocusSession(value: unknown): FocusSession {
  const row = envelopeOf(value);
  if (!row) {
    throw new Error("Missing focus session payload.");
  }

  const id = row.id;
  const roomId = row.room_id;
  const state = row.state;
  const duration = row.duration_seconds;
  const startedAt = row.started_at;
  const endsAt = row.ends_at;
  const pausedAt = row.paused_at;
  const pausedSeconds = row.paused_seconds;
  const endedAt = row.ended_at;

  if (
    typeof id !== "string" ||
    typeof roomId !== "string" ||
    !isFocusSessionState(state) ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    typeof startedAt !== "string" ||
    typeof endsAt !== "string" ||
    typeof pausedSeconds !== "number" ||
    !Number.isFinite(pausedSeconds) ||
    !((pausedAt === null || typeof pausedAt === "string")) ||
    !((endedAt === null || typeof endedAt === "string"))
  ) {
    throw new Error(
      `Unexpected focus session payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  // Same pairing the CHECK constraints enforce: a session is paused exactly
  // while it carries a pause timestamp, and finished exactly when it carries
  // an end timestamp.
  const isActive = state === "running" || state === "paused";
  if (
    (state === "paused") !== (pausedAt !== null) ||
    isActive !== (endedAt === null)
  ) {
    throw new Error(
      `Unexpected focus session payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  return {
    id,
    room_id: roomId,
    state,
    duration_seconds: duration,
    started_at: startedAt,
    ends_at: endsAt,
    paused_at: pausedAt,
    paused_seconds: pausedSeconds,
    ended_at: endedAt,
  };
}

/**
 * Turns an envelope into an error. A recognised code becomes a
 * `FocusSessionError`; anything unexpected throws so the route answers with a
 * generic 500 instead of echoing database output.
 */
function toFailure(data: unknown): FocusSessionError | null {
  const envelope = envelopeOf(data);
  const code = typeof envelope?.code === "string" ? envelope.code : null;
  if (code === null) {
    return null;
  }
  const failure = ERROR_RESULTS[code];
  return failure
    ? new FocusSessionError(failure.code, failure.message, failure.status)
    : null;
}

/**
 * `22023` is the duration CHECK inside `start_focus_session`; the API validates
 * first, so it only appears if something bypassed validation. Everything else
 * about a failed call (permission, network, expired token) is not forwarded.
 */
function rpcFailure(fn: string, error: { code?: string | null; message?: string | null }): Error {
  if (error.code === "22023") {
    return new FocusSessionError(
      "invalid",
      "Focus duration must be between 60 and 7200 seconds.",
      400,
    );
  }
  return new Error(`${fn} failed: ${error.message ?? "unknown error"}`);
}

/**
 * The read path: persists any passage of the deadline, then reports the
 * active session (or none), the caller's own role, the seat count and the
 * server clock in epoch milliseconds so a client can derive a countdown
 * without trusting its own clock.
 */
export async function readFocusState(
  client: SupabaseClient,
  roomId: string,
): Promise<FocusState> {
  const { data, error } = await client.rpc("focus_session_state", {
    p_room_id: roomId,
  });

  if (error) {
    throw rpcFailure("focus_session_state", error);
  }

  const envelope = envelopeOf(data);
  const code = typeof envelope?.code === "string" ? envelope.code : null;

  if (code !== "ok") {
    const failure = toFailure(data);
    if (failure) {
      throw failure;
    }
    throw new Error(
      `Unexpected focus state result: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  const session =
    envelope?.session === null || envelope?.session === undefined
      ? null
      : toFocusSession(envelope.session);
  const role = envelope?.viewer_role;
  const now = envelope?.server_now_ms;
  const count = envelope?.member_count;

  if ((role !== "owner" && role !== "student") ||
      typeof now !== "number" || !Number.isFinite(now) ||
      typeof count !== "number" || !Number.isFinite(count)) {
    throw new Error(
      `Unexpected focus state result: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  return {
    session,
    viewer_role: role,
    server_now_ms: now,
    member_count: count,
  };
}

async function runAction(
  client: SupabaseClient,
  fn:
    | "start_focus_session"
    | "pause_focus_session"
    | "resume_focus_session"
    | "end_focus_session",
  roomId: string,
  durationSeconds?: number,
): Promise<FocusActionResult> {
  const args =
    durationSeconds === undefined
      ? { p_room_id: roomId }
      : { p_room_id: roomId, p_duration_seconds: durationSeconds };

  const { data, error } = await client.rpc(fn, args);

  if (error) {
    throw rpcFailure(fn, error);
  }

  const envelope = envelopeOf(data);
  const code = typeof envelope?.code === "string" ? envelope.code : null;

  if (code !== null && SUCCESS_RESULTS.includes(code)) {
    return {
      action: code as FocusAction,
      session: toFocusSession(envelope?.session),
    };
  }

  const failure = toFailure(data);
  if (failure) {
    throw failure;
  }

  throw new Error(
    `Unexpected focus session result: ${JSON.stringify(data).slice(0, 200)}`,
  );
}

/**
 * Starts a session for the room the caller owns. A repeat call (or a race
 * that lost against another start) reports `already_active` with the session
 * that is already running instead of starting a second one.
 */
export function startFocusSession(
  client: SupabaseClient,
  roomId: string,
  durationSeconds: number,
): Promise<FocusActionResult> {
  return runAction(client, "start_focus_session", roomId, durationSeconds);
}

/** Freezes a running session; the remaining time stops moving. */
export function pauseFocusSession(
  client: SupabaseClient,
  roomId: string,
): Promise<FocusActionResult> {
  return runAction(client, "pause_focus_session", roomId);
}

/** Continues a paused session where it stopped, crediting the paused time. */
export function resumeFocusSession(
  client: SupabaseClient,
  roomId: string,
): Promise<FocusActionResult> {
  return runAction(client, "resume_focus_session", roomId);
}

/** Ends the active session early and records it as completed. */
export function endFocusSession(
  client: SupabaseClient,
  roomId: string,
): Promise<FocusActionResult> {
  return runAction(client, "end_focus_session", roomId);
}
