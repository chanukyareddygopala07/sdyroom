import type { ChatMessageView } from "./types";

/**
 * Catch-up history parsing and merging for chat reconciliation.
 *
 * The workspace page seeds history with a server render, and every message
 * from then on arrives as a Realtime `INSERT` — but a row committed between
 * that render and the subscription's join ack (a reload racing a send, or a
 * message sent while the socket was down) is observed by neither path. The
 * component therefore reads the room's newest history page over the
 * authorized `GET /api/rooms/[id]/messages` endpoint once per (re)subscribe
 * ack and merges it here.
 *
 * The merge is deliberately **additive**: it never removes or reorders rows
 * the client already observed, so a slow response that resolves after a
 * newer one can only contribute rows that are themselves part of history —
 * it can never overwrite newer state. Rows are deduplicated by id, which is
 * what keeps a message that arrives both as a Realtime event and in the
 * fetched page to a single copy.
 */

/**
 * Validates one row of a history page. The endpoint returns the same view
 * the Realtime path builds, so anything that does not match the contract is
 * dropped rather than rendered — a malformed row must not break catch-up for
 * the whole page.
 */
export function asChatMessageView(value: unknown): ChatMessageView | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.alias !== "string" ||
    typeof row.body !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.is_own !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    alias: row.alias,
    body: row.body,
    created_at: row.created_at,
    status: "sent",
    is_own: row.is_own,
  };
}

export type HistoryPage = {
  /** Oldest-to-newest within the page, as the endpoint returns them. */
  messages: ChatMessageView[];
  /** True when older pages exist below the oldest message returned. */
  has_more: boolean;
};

/**
 * Parses a `GET /api/rooms/[id]/messages` body onto a history page, or
 * returns `null` for anything that is not the documented envelope — a proxy
 * error page or a truncated body is ignored, not rendered.
 */
export function parseHistoryPage(value: unknown): HistoryPage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.messages)) {
    return null;
  }
  const messages: ChatMessageView[] = [];
  for (const row of envelope.messages) {
    const view = asChatMessageView(row);
    if (view === null) {
      return null;
    }
    messages.push(view);
  }
  return { messages, has_more: envelope.has_more === true };
}

/**
 * Ordered union of what the client has observed and one fetched history
 * page (pages arrive newest-first from the caller, already stitched
 * oldest-to-newest within this merge).
 *
 * Rules:
 * - The held copy of a row wins when the same id appears on both sides:
 *   `room_messages` is append-only (no UPDATE grant), so the copies are the
 *   same immutable row, and keeping the held one never churns a key the
 *   list already rendered. Realtime ∩ fetch therefore collapses to one
 *   copy; an optimistic row's `local-*` id never collides — the send's own
 *   response removes it exactly as before.
 * - The relative order of `current` is kept; fetched rows are woven in by
 *   `created_at`, which is the server clock the endpoint and Realtime both
 *   stamp. Equal timestamps take the fetched row's position first: the
 *   endpoint orders those by `seq`, which the client never sees, so its
 *   order is the best available — and it keeps the result deterministic.
 * - If every fetched row is already held, the current array is returned
 *   untouched (same reference), so an ack that observed nothing new does
 *   not churn the list.
 */
export function mergeChatHistory(
  current: ChatMessageView[],
  fetched: ChatMessageView[],
): ChatMessageView[] {
  if (fetched.length === 0) {
    return current;
  }

  const held = new Set(current.map((row) => row.id));
  if (fetched.every((row) => held.has(row.id))) {
    return current;
  }

  const seen = new Set<string>();
  const merged: ChatMessageView[] = [];
  let next = 0;

  for (const row of current) {
    while (next < fetched.length && fetched[next].created_at <= row.created_at) {
      const candidate = fetched[next];
      next += 1;
      if (!held.has(candidate.id) && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        merged.push(candidate);
      }
    }
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }

  while (next < fetched.length) {
    const candidate = fetched[next];
    next += 1;
    if (!held.has(candidate.id) && !seen.has(candidate.id)) {
      seen.add(candidate.id);
      merged.push(candidate);
    }
  }

  return merged;
}
