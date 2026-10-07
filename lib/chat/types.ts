/**
 * Shared shapes for room chat and presence.
 *
 * The view types here are the contract between the props-driven
 * {@link ChatPanel} and its data layer: history is read with the workspace
 * page (`GET /api/rooms/[id]/messages`), `RoomChat` sends new messages over
 * the same endpoint and maps Realtime rows onto this shape, and the panel
 * renders without ever fetching. Participant presence is delivered the same
 * way — `RoomChat` reduces the room's presence state onto
 * {@link ChatParticipant} and hands the panel a list, or nothing at all
 * while the join has not answered yet.
 */

/** Delivery state of one message as the viewer sees it. */
export type ChatMessageStatus =
  /** Confirmed by the server (or observed over Realtime). */
  | "sent"
  /** Optimistically shown while the send is in flight. */
  | "pending"
  /** The send failed; the viewer can retry it. */
  | "failed";

export type ChatMessageView = {
  /**
   * Stable id for list keys and retry targets. A server row carries its own
   * id; an optimistic row uses a client-generated one until confirmed.
   */
  id: string;
  /** The sender's unique study alias. */
  alias: string;
  /** Message text, already within {@link CHAT_MESSAGE_MAX_LENGTH}. */
  body: string;
  /** ISO timestamp from the server clock; rendered as a `<time>` element. */
  created_at: string;
  status: ChatMessageStatus;
  /** True when the viewer sent it — used for layout and labels, not trust. */
  is_own: boolean;
};

/**
 * One member currently present in the room, as the viewer sees them.
 *
 * `alias` is the member's study alias as *they* reported it in the presence
 * payload — untrusted display data, never a user id and never a trust
 * signal (see `toParticipants`). `studying` means the room's shared focus
 * session is running or paused: `focus_sessions` is room-scoped with a
 * single active row and no starter column (0003), so this is the honest
 * per-member reading of "in a focus session" — each client derives it from
 * its own workspace state and reports it about itself.
 */
export type ChatParticipant = {
  alias: string;
  studying: boolean;
};

/**
 * State of the channel that brings new messages in — mirrors the existing
 * focus-timer contract (`Connecting… / Live / Reconnecting…`) plus
 * `unavailable` for when chat itself is not offered.
 */
export type ChatConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unavailable";

/** Maximum message length, enforced by the API and the composer alike. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;
