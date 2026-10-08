import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isExpired,
  type AcceptOutcome,
  type InvitationView,
  type RoomMemberView,
} from "./types";

/**
 * The invitation data layer: RPC wrappers and the two RLS-backed listings.
 *
 * Every mutation is an RPC — the table carries no INSERT/UPDATE/DELETE grant,
 * so this module cannot write rows even if a bug tried. Codes come back as
 * successful RPC results (the 0002/0003 convention); an `error` from the call
 * itself means the call failed (permission, network) and is deliberately
 * turned into a generic failure rather than forwarded to the client.
 */

export type InvitationErrorCode =
  | "not_found"
  | "not_owner"
  | "room_public"
  | "invitee_not_found"
  | "self_invite"
  | "already_member"
  | "already_invited"
  | "used"
  | "rejected"
  | "revoked"
  | "expired"
  | "room_full"
  | "room_closed"
  | "blocked";

/** Failure carrying the HTTP status the API layer returns. */
export class InvitationError extends Error {
  readonly code: InvitationErrorCode;
  readonly status: number;

  constructor(code: InvitationErrorCode, message: string, status: number) {
    super(message);
    this.name = "InvitationError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The public vocabulary for every invitation RPC result. Messages are written
 * here, never taken from the database, so SQL text and constraint names never
 * reach a response body. Codes not listed are unexpected and throw, which
 * surfaces as a 500 with a generic code.
 */
const ERROR_RESULTS: Record<
  string,
  { code: InvitationErrorCode; status: number; message: string }
> = {
  room_not_found: {
    code: "not_found",
    status: 404,
    message: "That room does not exist or is not available.",
  },
  not_found: {
    code: "not_found",
    status: 404,
    message: "That invitation does not exist or is not available.",
  },
  not_owner: {
    code: "not_owner",
    status: 403,
    message: "Only the room owner can manage invitations.",
  },
  room_public: {
    code: "room_public",
    status: 409,
    message: "Invitations are for private rooms — anyone can join a public room.",
  },
  invitee_not_found: {
    code: "invitee_not_found",
    status: 404,
    message: "No student studies under that alias.",
  },
  self_invite: {
    code: "self_invite",
    status: 409,
    message: "You cannot invite yourself.",
  },
  already_member: {
    code: "already_member",
    status: 409,
    message: "That student is already in this room.",
  },
  already_invited: {
    code: "already_invited",
    status: 409,
    message: "That student already has a pending invitation for this room.",
  },
  used: {
    code: "used",
    status: 409,
    message: "This invitation has already been accepted.",
  },
  rejected: {
    code: "rejected",
    status: 409,
    message: "This invitation was rejected.",
  },
  revoked: {
    code: "revoked",
    status: 409,
    message: "This invitation was revoked by the room owner.",
  },
  expired: {
    code: "expired",
    status: 410,
    message: "This invitation has expired.",
  },
  room_full: {
    code: "room_full",
    status: 409,
    message: "This room is full.",
  },
  room_closed: {
    code: "room_closed",
    status: 409,
    message: "This room is closed and is not accepting new members.",
  },
  blocked: {
    code: "blocked",
    status: 409,
    message: "This invitation is not available.",
  },
};

function toError(data: unknown): never {
  const envelope =
    data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof envelope?.code === "string" ? envelope.code : null;
  const failure = code !== null ? ERROR_RESULTS[code] : undefined;

  if (failure) {
    throw new InvitationError(failure.code, failure.message, failure.status);
  }

  throw new Error(
    `Unexpected invitation result: ${JSON.stringify(data).slice(0, 200)}`,
  );
}

function envelopeOf(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    throw new Error(
      `Unexpected invitation result: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data as Record<string, unknown>;
}

async function callRpc(
  client: SupabaseClient,
  fn:
    | "create_room_invitation"
    | "accept_room_invitation"
    | "reject_room_invitation"
    | "revoke_room_invitation",
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(fn, args);

  if (error) {
    throw new Error(`${fn} failed: ${error.message}`);
  }

  return envelopeOf(data);
}

function toView(row: Record<string, unknown>): InvitationView {
  const status = String(row.status);
  const expiresAt = String(row.expires_at);
  return {
    id: String(row.id),
    room_id: String(row.room_id),
    room_name: String(row.room_name),
    inviter_alias: String(row.inviter_alias),
    invitee_alias: String(row.invitee_alias),
    status: status as InvitationView["status"],
    created_at: String(row.created_at),
    expires_at: expiresAt,
    resolved_at: row.resolved_at === null || row.resolved_at === undefined
      ? null
      : String(row.resolved_at),
    expired: isExpired(status as InvitationView["status"], expiresAt),
  };
}

function toInvitationField(envelope: Record<string, unknown>): InvitationView {
  const invitation = envelope.invitation;
  if (!invitation || typeof invitation !== "object") {
    throw new Error("create_room_invitation returned no invitation");
  }
  return toView(invitation as Record<string, unknown>);
}

/**
 * Creates an invitation as the owner of a private room. The invitee is
 * addressed by alias; `inviter_id` is derived from `auth.uid()` inside the
 * RPC and is not a parameter of this call at all.
 */
export async function createInvitation(
  client: SupabaseClient,
  roomId: string,
  inviteeAlias: string,
  ttlHours: number,
): Promise<InvitationView> {
  const data = await callRpc(client, "create_room_invitation", {
    p_room_id: roomId,
    p_invitee_alias: inviteeAlias,
    p_ttl_hours: ttlHours,
  });

  if (data.code !== "invited") {
    toError(data);
  }

  return toInvitationField(data);
}

/** Accepts an invitation addressed to the caller. Atomic: status and seat. */
export async function acceptInvitation(
  client: SupabaseClient,
  invitationId: string,
): Promise<AcceptOutcome> {
  const data = await callRpc(client, "accept_room_invitation", {
    p_invitation_id: invitationId,
  });

  const code =
    data.code === "joined" || data.code === "already_member"
      ? data.code
      : null;
  if (code === null) {
    toError(data);
  }

  const roomId = data.room_id;
  if (typeof roomId !== "string") {
    throw new Error("accept_room_invitation returned no room_id");
  }

  const count = Number(data.member_count);
  return {
    membership: code,
    room_id: roomId,
    room_name: typeof data.room_name === "string" ? data.room_name : "",
    member_count: Number.isFinite(count) ? count : null,
  };
}

/** Rejects an invitation addressed to the caller. */
export async function rejectInvitation(
  client: SupabaseClient,
  invitationId: string,
): Promise<void> {
  const data = await callRpc(client, "reject_room_invitation", {
    p_invitation_id: invitationId,
  });

  // The RPC answers `ok` on the flip and `rejected` (a 409) for a repeat:
  // success and failure must not share a code.
  if (data.code !== "ok") {
    toError(data);
  }
}

/** Revokes a pending invitation the caller created (owner-only, in the RPC). */
export async function revokeInvitation(
  client: SupabaseClient,
  invitationId: string,
): Promise<void> {
  const data = await callRpc(client, "revoke_room_invitation", {
    p_invitation_id: invitationId,
  });

  if (data.code !== "revoked") {
    toError(data);
  }
}

/**
 * The owner's list for one room. RLS already narrows rows to those the
 * caller created (`room_invitations_select_addressed`); the route confirms
 * the owner role before calling, and the projection excludes both user-id
 * columns even though the grant would allow them.
 */
export async function listRoomInvitations(
  client: SupabaseClient,
  roomId: string,
): Promise<InvitationView[]> {
  const { data, error } = await client
    .from("room_invitations")
    .select(
      "id, room_id, room_name, inviter_alias, invitee_alias, status, created_at, expires_at, resolved_at",
    )
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`invitations list failed: ${error.message}`);
  }

  return (data ?? []).map((row) => toView(row as Record<string, unknown>));
}

/**
 * The caller's inbox: only rows addressed to them (`invitee_id` filter on
 * top of the policy, so an inviter's own outgoing rows can never leak into
 * the invitee view even by accident).
 */
export async function listMyInvitations(
  client: SupabaseClient,
  viewerId: string,
): Promise<InvitationView[]> {
  const { data, error } = await client
    .from("room_invitations")
    .select(
      "id, room_id, room_name, inviter_alias, invitee_alias, status, created_at, expires_at, resolved_at",
    )
    .eq("invitee_id", viewerId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`invitations list failed: ${error.message}`);
  }

  return (data ?? []).map((row) => toView(row as Record<string, unknown>));
}

/** Raised when the roster RPC refuses the caller (left the room mid-request). */
export class RosterDeniedError extends Error {
  constructor() {
    super("That room does not exist or is not available.");
    this.name = "RosterDeniedError";
  }
}

/**
 * The roster through the membership-checked definer RPC. A non-member and a
 * nonexistent room raise the same PostgREST error (42501), which surfaces as
 * `RosterDeniedError` — the same 404 the route's membership check produces —
 * so the function cannot become an existence oracle.
 */
export async function roomRoster(
  client: SupabaseClient,
  roomId: string,
): Promise<RoomMemberView[]> {
  const { data, error } = await client.rpc("room_roster", {
    p_room_id: roomId,
  });

  if (error) {
    if (error.code === "42501") {
      throw new RosterDeniedError();
    }
    throw new Error(`room_roster failed: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    const role = record.role === "owner" ? "owner" : "student";
    return {
      alias: String(record.alias),
      role,
      joined_at: String(record.joined_at),
    };
  });
}

/**
 * Reads one room's `visibility` for the workspace page.
 *
 * The workspace shape (`PublicRoom`) deliberately strips `visibility`, but
 * the invite panel is only offered for a private room the viewer owns — and
 * this read is protected by the ordinary `rooms` policies: a member or owner
 * sees the row, everyone else gets `null`, which hides the panel rather than
 * revealing the room. Returns `null` when the row is not visible, and only
 * the literal `'private'` value turns the panel on.
 */
export async function readRoomVisibility(
  client: SupabaseClient,
  roomId: string,
): Promise<"private" | null> {
  const { data, error } = await client
    .from("rooms")
    .select("visibility")
    .eq("id", roomId)
    .maybeSingle();

  if (error) {
    throw new Error(`visibility read failed: ${error.message}`);
  }

  return data?.visibility === "private" ? "private" : null;
}
