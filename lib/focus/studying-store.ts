import { useSyncExternalStore } from "react";

/**
 * The room's "are we studying?" flag, published by the component that owns
 * the focus session and read by the component that owns presence.
 *
 * `FocusTimer` is the single source of truth for the shared session state;
 * `RoomChat` must report the same fact about the viewer in its presence
 * track. The two are siblings on the workspace page, so the value travels
 * through this tiny store instead of a context provider (which would have to
 * wrap a server component's output) or a third Realtime subscription (which
 * the session's own channel already covers).
 *
 * `studying` is room-scoped: `focus_sessions` has one active row per room
 * and deliberately no starter column (0003), so a running session is the
 * room's, not any individual's — see `ChatParticipant` for why that is the
 * honest reading.
 *
 * A module-level store is safe here because exactly one workspace is on
 * screen at a time, and both ends unmount together (the page keys both
 * components per room): the timer publishes `false` as it unmounts, so a
 * room switch can never leave the previous room's flag behind.
 */

let studying = false;
const listeners = new Set<() => void>();

/** Publishes the current flag; identical values notify nobody. */
export function publishStudying(next: boolean): void {
  if (studying === next) return;
  studying = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeStudying(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function studyingSnapshot(): boolean {
  return studying;
}

/**
 * Subscribes a component to the flag. The server snapshot is the same
 * function: during SSR nothing has published yet, so a server-rendered page
 * never claims studying before the timer's first effect has run.
 */
export function useStudying(): boolean {
  return useSyncExternalStore(
    subscribeStudying,
    studyingSnapshot,
    studyingSnapshot,
  );
}
