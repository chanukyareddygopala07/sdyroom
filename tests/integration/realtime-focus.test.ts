import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFocusWorkspace } from "@/lib/focus/workspace";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql } from "./helpers/admin";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

/**
 * Real WebSocket delivery over the local Supabase Realtime service — no
 * mocked channel anywhere in this file. The browser suite drives the UI on
 * top of the same pipeline; this suite isolates the pipeline itself:
 * delivery, RLS-based subscriber isolation, late joins and channel rejoin
 * behaviour against the database's own writes.
 */

type PostgresFrame = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown>;
  old?: Record<string, unknown>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`Refusing to interpolate a malformed id: ${value}`);
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Condition not reached within the timeout.");
    }
    await sleep(50);
  }
}

type Subscription = {
  frames: PostgresFrame[];
  close: () => Promise<void>;
};

/**
 * Subscribes a client to a room's focus_sessions stream. The 500 ms grace
 * after SUBSCRIBED is the subscription-settle window: the join ack can
 * precede the server-side postgres_changes registration, and a write inside
 * it may not be delivered — verified against the local stack, not assumed.
 * It is generous because the suite runs alongside seven other files and
 * delivery has to survive that load, not just an idle machine.
 */
async function subscribe(user: TestUser, roomId: string): Promise<Subscription> {
  const channel = user.client.channel(`focus-${roomId}-${user.id.slice(0, 8)}`);
  const frames: PostgresFrame[] = [];
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "focus_sessions", filter: `room_id=eq.${roomId}` },
    (payload) => frames.push(payload as unknown as PostgresFrame),
  );
  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        reject(new Error(`subscription failed: ${status}`));
      }
    });
  });
  await sleep(500);
  return {
    frames,
    close: async () => {
      await user.client.removeChannel(channel);
    },
  };
}

/** A non-member must observe nothing — so the window itself is asserted. */
async function expectSilence(frames: PostgresFrame[]): Promise<void> {
  await sleep(800);
  expect(frames).toHaveLength(0);
}

describe("realtime delivery for focus sessions", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let publicRoomId: string;
  let privateRoomId: string;

  beforeAll(async () => {
    [owner, member, outsider] = await Promise.all([
      createUser("rt-owner"),
      createUser("rt-member"),
      createUser("rt-outsider"),
    ]);
    await Promise.all(
      [owner, member, outsider].map((user, index) =>
        createProfile(user.client, user.id, uniqueAlias(`RT${index}`)),
      ),
    );

    publicRoomId = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({ name: uniqueName("RT Public"), capacity: 4 }),
      )
    ).id;
    await joinRoom(member.client, publicRoomId);

    privateRoomId = (
      await createRoom(
        owner.client,
        createRoomSchema.parse({
          name: uniqueName("RT Private"),
          capacity: 4,
          visibility: "private",
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await deleteUsers([owner, member, outsider]);
  });

  /** Leftover active sessions would turn the next start into a 409. */
  async function forceIdle(): Promise<void> {
    await owner.client.rpc("end_focus_session", { p_room_id: publicRoomId });
    await owner.client.rpc("end_focus_session", { p_room_id: privateRoomId });
  }

  it("delivers INSERT and UPDATE frames to a member's socket", async () => {
    await forceIdle();
    const sub = await subscribe(member, publicRoomId);
    try {
      const { error } = await owner.client.rpc("start_focus_session", {
        p_room_id: publicRoomId,
        p_duration_seconds: 1500,
      });
      expect(error).toBeNull();
      await waitFor(() => sub.frames.some((frame) => frame.eventType === "INSERT"));
      const insert = sub.frames.find((frame) => frame.eventType === "INSERT");
      expect(insert?.new.state).toBe("running");
      expect(insert?.new.room_id).toBe(publicRoomId);

      await owner.client.rpc("pause_focus_session", { p_room_id: publicRoomId });
      await waitFor(() =>
        sub.frames.some(
          (frame) => frame.eventType === "UPDATE" && frame.new.state === "paused",
        ),
      );

      await owner.client.rpc("end_focus_session", { p_room_id: publicRoomId });
      await waitFor(() =>
        sub.frames.some(
          (frame) =>
            frame.eventType === "UPDATE" &&
            (frame.new.state === "completed" || frame.new.state === "expired"),
        ),
      );
    } finally {
      await sub.close();
    }
  });

  it("delivers nothing to non-members of a public room", async () => {
    await forceIdle();
    const outsiderSub = await subscribe(outsider, publicRoomId);
    const memberSub = await subscribe(member, publicRoomId);
    try {
      await owner.client.rpc("start_focus_session", {
        p_room_id: publicRoomId,
        p_duration_seconds: 1500,
      });
      // The member's frame proves the pipeline was live during the window.
      await waitFor(() => memberSub.frames.some((frame) => frame.eventType === "INSERT"));
      await expectSilence(outsiderSub.frames);
      await owner.client.rpc("end_focus_session", { p_room_id: publicRoomId });
    } finally {
      await outsiderSub.close();
      await memberSub.close();
    }
  });

  it("delivers a private room's frames only to that room's members", async () => {
    await forceIdle();
    // member and outsider are not in the private room: same table, same
    // event, different authorization — nothing must reach them.
    const ownerSub = await subscribe(owner, privateRoomId);
    const memberSub = await subscribe(member, privateRoomId);
    const outsiderSub = await subscribe(outsider, privateRoomId);
    try {
      await owner.client.rpc("start_focus_session", {
        p_room_id: privateRoomId,
        p_duration_seconds: 1500,
      });
      await waitFor(() => ownerSub.frames.some((frame) => frame.eventType === "INSERT"));
      await expectSilence(memberSub.frames);
      await expectSilence(outsiderSub.frames);
      await owner.client.rpc("end_focus_session", { p_room_id: privateRoomId });
    } finally {
      await ownerSub.close();
      await memberSub.close();
      await outsiderSub.close();
    }
  });

  it("gives a late subscriber both the current state and later changes", async () => {
    await forceIdle();
    await owner.client.rpc("start_focus_session", {
      p_room_id: publicRoomId,
      p_duration_seconds: 1500,
    });

    // The subscriber joins after the INSERT: no replay is expected, but the
    // canonical read and the next change must both work.
    const sub = await subscribe(member, publicRoomId);
    try {
      const workspace = await getFocusWorkspace(member.client, publicRoomId);
      expect(workspace.session?.state).toBe("running");

      await owner.client.rpc("pause_focus_session", { p_room_id: publicRoomId });
      await waitFor(() =>
        sub.frames.some(
          (frame) => frame.eventType === "UPDATE" && frame.new.state === "paused",
        ),
      );

      const afterPause = await getFocusWorkspace(member.client, publicRoomId);
      expect(afterPause.session?.state).toBe("paused");
      await owner.client.rpc("end_focus_session", { p_room_id: publicRoomId });
    } finally {
      await sub.close();
    }
  });

  it("rejoining the channel neither duplicates rows nor double-counts events", async () => {
    await forceIdle();
    const rowsBefore = Number(
      psql(
        `select count(*) from public.focus_sessions where room_id = '${assertUuid(publicRoomId)}';`,
      ),
    );

    const first = await subscribe(member, publicRoomId);
    await owner.client.rpc("start_focus_session", {
      p_room_id: publicRoomId,
      p_duration_seconds: 1500,
    });
    await waitFor(() => first.frames.some((frame) => frame.eventType === "INSERT"));
    await first.close();

    // Reconnect: a fresh channel for the same stream, as a client rejoining
    // after a drop would create.
    const second = await subscribe(member, publicRoomId);
    try {
      await owner.client.rpc("pause_focus_session", { p_room_id: publicRoomId });
      await waitFor(() =>
        second.frames.some(
          (frame) => frame.eventType === "UPDATE" && frame.new.state === "paused",
        ),
      );
      await owner.client.rpc("end_focus_session", { p_room_id: publicRoomId });
      await waitFor(() =>
        second.frames.some(
          (frame) =>
            frame.eventType === "UPDATE" &&
            (frame.new.state === "completed" || frame.new.state === "expired"),
        ),
      );

      // Give any duplicate delivery a chance to surface before counting.
      await sleep(500);
      expect(
        second.frames.filter(
          (frame) => frame.eventType === "UPDATE" && frame.new.state === "paused",
        ),
      ).toHaveLength(1);
      expect(
        second.frames.filter(
          (frame) => frame.eventType === "UPDATE" && frame.new.state === "running",
        ),
      ).toHaveLength(0);

      // Exactly one new row for the cycle; no active leftovers.
      const rowsAfter = Number(
        psql(
          `select count(*) from public.focus_sessions where room_id = '${assertUuid(publicRoomId)}';`,
        ),
      );
      expect(rowsAfter).toBe(rowsBefore + 1);
      const active = Number(
        psql(
          `select count(*) from public.focus_sessions ` +
            `where room_id = '${assertUuid(publicRoomId)}' and state in ('running','paused');`,
        ),
      );
      expect(active).toBe(0);
    } finally {
      await second.close();
    }
  });
});
