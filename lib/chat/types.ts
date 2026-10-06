/**
 * Shared shapes for room chat and presence.
 *
 * The view types here are the contract between the props-driven
 * {@link ChatPanel} and its data layer: history is read with the workspace
 * page (`GET /api/rooms/[id]/messages`), `RoomChat` sends new messages over
 * the same endpoint and maps Realtime rows onto this shape, and the panel
 * renders without ever fetching. Participant presence remains a proposal —
 * the panel hides that section until a contract supplies it.
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

/** Proposed participant shape; only rendered once presence is contracted. */
export type ChatParticipant = {
  alias: string;
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
