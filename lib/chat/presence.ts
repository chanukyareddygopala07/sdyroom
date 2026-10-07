import type { ChatParticipant } from "./types";

/**
 * The client half of room presence: the channel topic, the track payload and
 * the reduction from a Realtime presence state to the `ChatParticipant[]`
 * the panel renders.
 *
 * Everything in this module is pure and synchronous on purpose — it is the
 * part of presence that decides *what the viewer is told*, so it can be
 * tested without a socket, and the transport in `RoomChat` stays a thin
 * layer of join/track/sync around it.
 *
 * Security note: a presence payload is **client-supplied display data**.
 * Aliases arrive from other browsers, so they are validated and truncated
 * here and never used for anything but rendering — no `is_own` flag, no
 * authorization, no id of any kind is read from them (see
 * `docs/SECURITY.md`).
 */

/**
 * Topic of the per-room private channel. The shape is a contract with the
 * database: `0006_realtime_private_channels.sql` authorizes exactly topics
 * matching `room-presence-<uuid>` for current members of `<uuid>`, so this
 * prefix may never change independently of the migration.
 */
export function presenceChannelTopic(roomId: string): string {
  return `room-presence-${roomId}`;
}

/**
 * How often a joined client re-sends its own track. Realtime removes a
 * presence the moment its socket closes, so this is not the primary leave
 * signal — it is the guard against a half-open socket whose disconnect the
 * server never saw, and it doubles as the retry bound: the client never
 * re-tracks faster than this unless its own state actually changed.
 */
export const PRESENCE_HEARTBEAT_MS = 60_000;

/** The only fields presence ever carries. No ids, no email, no phone. */
export type PresenceTrackPayload = {
  alias: string;
  studying: boolean;
};

/** Mirrors a `realtime.presenceState()` entry structurally. */
type PresenceEntry = {
  presence_ref?: unknown;
  alias?: unknown;
  studying?: unknown;
};

/** The shape of `channel.presenceState()` without importing realtime-js. */
export type PresenceState = Record<string, PresenceEntry[] | undefined>;

/**
 * Same ceiling as `profiles.alias` (0001): a real alias is never longer, and
 * a spoofed one is clamped instead of reaching the DOM. Trimmed, because
 * padding an alias with spaces must not produce a second badge.
 */
const ALIAS_MAX_LENGTH = 32;

function readAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > ALIAS_MAX_LENGTH
    ? trimmed.slice(0, ALIAS_MAX_LENGTH)
    : trimmed;
}

/**
 * Reduces a presence state to the list the panel shows.
 *
 * - Entries whose alias is missing or unusable are dropped: the panel never
 *   invents a name for a payload it cannot read.
 * - `studying` is true only for the literal `true` — a truthy string from a
 *   hand-written client must not turn into a claim.
 * - Two presence keys reporting the same alias (the same person in two
 *   tabs, or a spoof) collapse into one badge rather than duplicating a
 *   React key; the merged badge is studying if any copy is.
 * - The viewer's own alias sorts first, then aliases compare
 *   case-insensitively, so the list order never jumps between syncs.
 */
export function toParticipants(
  state: PresenceState,
  ownAlias: string,
): ChatParticipant[] {
  const byAlias = new Map<string, ChatParticipant>();

  for (const entries of Object.values(state)) {
    for (const entry of entries ?? []) {
      const alias = readAlias(entry?.alias);
      if (alias === null) continue;
      const studying = entry?.studying === true;
      const key = alias.toLowerCase();
      const existing = byAlias.get(key);
      if (existing) {
        existing.studying = existing.studying || studying;
      } else {
        byAlias.set(key, { alias, studying });
      }
    }
  }

  const own = ownAlias.trim().toLowerCase();
  return [...byAlias.values()].sort((a, b) => {
    const aOwn = own !== "" && a.alias.toLowerCase() === own;
    const bOwn = own !== "" && b.alias.toLowerCase() === own;
    if (aOwn !== bOwn) return aOwn ? -1 : 1;
    const folded = a.alias.toLowerCase().localeCompare(b.alias.toLowerCase());
    return folded !== 0 ? folded : a.alias.localeCompare(b.alias);
  });
}
