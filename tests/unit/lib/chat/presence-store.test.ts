import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRoomPresence,
  presenceSnapshot,
  publishRoomPresence,
  subscribePresence,
} from "@/lib/chat/presence-store";
import type { ChatParticipant } from "@/lib/chat/types";

const ALICE: ChatParticipant = { alias: "alice", studying: false };
const BOB_STUDYING: ChatParticipant = { alias: "bob", studying: true };

describe("presence store", () => {
  afterEach(() => {
    clearRoomPresence("room-a");
    clearRoomPresence("room-b");
  });

  it("starts empty and notifies only on a real change", () => {
    expect(presenceSnapshot()).toBeUndefined();

    const listener = vi.fn();
    const unsubscribe = subscribePresence(listener);

    publishRoomPresence("room-a", [ALICE]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(presenceSnapshot()).toEqual({ roomId: "room-a", participants: [ALICE] });

    // An identical publish is a no-op: no roster re-render for no reason.
    publishRoomPresence("room-a", [{ alias: "alice", studying: false }]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishRoomPresence("room-a", [BOB_STUDYING]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears a room on request and ignores clears for other rooms", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePresence(listener);

    publishRoomPresence("room-a", [ALICE]);
    expect(listener).toHaveBeenCalledTimes(1);

    // The publisher leaving another room must not touch this one.
    clearRoomPresence("room-b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(presenceSnapshot()?.roomId).toBe("room-a");

    clearRoomPresence("room-a");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(presenceSnapshot()).toBeUndefined();

    unsubscribe();
  });
});
