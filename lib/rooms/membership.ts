import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Outcomes the API turns into success responses:
 *   `joined`          -> 201, a membership row was created
 *   `already_member`  -> 200, idempotent repeat (the owner lands here too)
 *   `left`            -> 200, the caller's membership was removed
 */
export type MembershipOutcome = "joined" | "already_member" | "left";

export type MembershipErrorCode =
  | "not_found"
  | "room_closed"
  | "room_full"
  | "owner_cannot_leave"
  | "not_a_member";

/** Failure carrying the HTTP status the API layer returns. */
export class MembershipError extends Error {
  readonly code: MembershipErrorCode;
  readonly status: number;

  constructor(code: MembershipErrorCode, message: string, status: number) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
    this.status = status;
  }
}

export type MembershipResult = {
  membership: MembershipOutcome;
  /** Aggregate seats used, or null where the room is not public. */
  member_count: number | null;
};

/**
 * Codes returned by `join_room` / `leave_room`, mapped onto the public
 * vocabulary. Messages are written here rather than taken from the database so
 * SQL text, table names and constraint details never reach a response body.
 */
const ERROR_RESULTS: Record<
  string,
  { code: MembershipErrorCode; status: number; message: string }
> = {
  room_not_found: {
    code: "not_found",
    status: 404,
    message: "That room does not exist or is not available.",
  },
  room_closed: {
    code: "room_closed",
    status: 409,
    message: "This room is closed and is not accepting new members.",
  },
  room_full: {
    code: "room_full",
    status: 409,
    message: "This room is full.",
  },
  owner_cannot_leave: {
    code: "owner_cannot_leave",
    status: 409,
    message: "You own this room, so you cannot leave it.",
  },
  not_a_member: {
    code: "not_a_member",
    status: 409,
    message: "You are not a member of this room.",
  },
};

function toMemberCount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

/**
 * Interprets the JSON envelope the RPC returns. A recognised failure becomes a
 * `MembershipError`; anything unexpected throws so the route can answer with a
 * generic 500 instead of echoing database output.
 */
function toResult(data: unknown): MembershipResult {
  const envelope =
    data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof envelope?.code === "string" ? envelope.code : null;

  if (code === "joined" || code === "already_member" || code === "left") {
    return {
      membership: code,
      member_count: toMemberCount(envelope?.member_count),
    };
  }

  const failure = code !== null ? ERROR_RESULTS[code] : undefined;
  if (failure) {
    throw new MembershipError(failure.code, failure.message, failure.status);
  }

  throw new Error(
    `Unexpected membership result: ${JSON.stringify(data).slice(0, 200)}`,
  );
}

async function callRpc(
  client: SupabaseClient,
  fn: "join_room" | "leave_room",
  roomId: string,
): Promise<MembershipResult> {
  const { data, error } = await client.rpc(fn, { p_room_id: roomId });

  if (error) {
    // The documented codes come back as a successful RPC result; an error here
    // means the call itself failed (permission, network, bad argument) and is
    // deliberately not forwarded to the client.
    throw new Error(`${fn} failed: ${error.message}`);
  }

  return toResult(data);
}

/**
 * Joins an open public room as the caller. The identity always comes from
 * `auth.uid()` inside the function — no user id is ever passed in — and the
 * capacity check shares a row lock with the insert, so concurrent attempts
 * cannot exceed capacity.
 */
export async function joinRoom(
  client: SupabaseClient,
  roomId: string,
): Promise<MembershipResult> {
  return callRpc(client, "join_room", roomId);
}

/**
 * Leaves a room the caller joined. Only the caller's own student membership is
 * ever removed; the owner cannot leave through this operation.
 */
export async function leaveRoom(
  client: SupabaseClient,
  roomId: string,
): Promise<MembershipResult> {
  return callRpc(client, "leave_room", roomId);
}
