import { useSyncExternalStore } from "react";
import type { ChatParticipant } from "./types";

/**
 * The room's observed presence list, published by the component that owns
 * the presence channel and read by the member roster that annotates
 * membership with it.
 *
 * `RoomChat` subscribes to `room-presence-{roomId}` and hands participants to
 * the chat panel; the roster (007) sits elsewhere on the same workspace and
 * needs the same observation without a second subscription — one socket, one
 * track, one heartbeat, two readers. The roster never fetches or stores
 * presence itself, so a page refresh shows no one as online until a live
 * channel actually says so: presence is ephemeral by construction.
 *
 * The snapshot is keyed by room: exactly one workspace is on screen, both
 * readers unmount together per room, and the publisher clears its room as it
 * leaves — so a room switch can never show the previous room's watchers. The
 * server snapshot is the same function as the client one: during SSR nothing
 * has published yet, so a server-rendered roster never annotates anyone.
 */

type PresenceSnapshot =
  | { roomId: string; participants: ChatParticipant[] }
  | undefined;

let snapshot: PresenceSnapshot = undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function sameParticipants(
  a: ChatParticipant[],
  b: ChatParticipant[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (item, index) =>
      item.alias === b[index].alias && item.studying === b[index].studying,
  );
}

/** Publishes the latest observation for a room; identical lists notify nobody. */
export function publishRoomPresence(
  roomId: string,
  participants: ChatParticipant[],
): void {
  if (snapshot?.roomId === roomId && sameParticipants(snapshot.participants, participants)) {
    return;
  }
  snapshot = { roomId, participants };
  notify();
}

/** Forgets a room's observation — called when the owning channel unmounts. */
export function clearRoomPresence(roomId: string): void {
  if (snapshot?.roomId !== roomId) return;
  snapshot = undefined;
  notify();
}

function getSnapshot(): PresenceSnapshot {
  return snapshot;
}

/** The current observation, or nothing — the server snapshot too. */
export function presenceSnapshot(): PresenceSnapshot {
  return snapshot;
}

export function subscribePresence(listener: () => void): () => void {
  return subscribe(listener);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The participants observed for `roomId`, or `undefined` while no channel
 * for this room has synced yet (or after it left). `undefined` is distinct
 * from "nobody is here": the roster annotates only what a live channel
 * actually reported, exactly like the chat panel's own section.
 */
export function useRoomPresence(roomId: string): ChatParticipant[] | undefined {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return value !== undefined && value.roomId === roomId
    ? value.participants
    : undefined;
}
