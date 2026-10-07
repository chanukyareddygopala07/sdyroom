/**
 * The invitation and roster shapes the API exposes. Two rules shape every
 * type here:
 *
 *  - **No user ids.** `inviter_id` / `invitee_id` exist in the table (the
 *    policies need them) and are granted for SELECT, but the routes never
 *    project them: parties address each other by the alias columns copied at
 *    create time.
 *  - **`expired` is derived, never stored.** It is computed by the reader
 *    from `status === "pending"` plus `expires_at`, matching the database's
 *    read-time evaluation (the row stays `pending`; acceptance answers 410).
 */

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "revoked",
] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** One invitation as the addressed party (or its owner) may see it. */
export type InvitationView = {
  id: string;
  room_id: string;
  /** Copied at create time — the invitee cannot read `rooms` before accept. */
  room_name: string;
  /** Copied at create time: who sent it (owner-facing lists use invitee_alias). */
  inviter_alias: string;
  /** Copied at create time: who it is for. */
  invitee_alias: string;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  /** Reader-side expiry: pending and already past `expires_at`. */
  expired: boolean;
};

/** A room roster row: display identity and seat metadata only. */
export type RoomMemberView = {
  alias: string;
  role: "owner" | "student";
  joined_at: string;
};

export type AcceptOutcome = {
  membership: "joined" | "already_member";
  room_id: string;
  room_name: string;
  member_count: number | null;
};

/** True for a pending invitation whose deadline has passed. */
export function isExpired(status: InvitationStatus, expiresAt: string): boolean {
  return status === "pending" && Date.parse(expiresAt) <= Date.now();
}
