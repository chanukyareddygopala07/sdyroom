/**
 * Client-side shapes for room chat and presence.
 *
 * The backend for chat is owned by a separate developer and is not merged
 * yet, so this module is a *proposal*: it fixes the view types the UI is
 * built and tested against, and the endpoints that would populate them are
 * written down in the pull request description. Nothing in the app fetches
 * or fabricates this data until the agreed contract lands — the panel is
 * rendered from props only, so every state below can be exercised by tests
 * without a server.
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

/** A participant reported by the approved presence contract, if any. */
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

/** Proposed maximum message length; the API must validate the same bound. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;
