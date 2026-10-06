import { expect, test } from "@playwright/test";
import {
  createRoomViaUi,
  enterRoomViaUi,
  focusTimer,
  joinRoomViaUi,
  searchRooms,
  startSession,
  syncStatus,
  waitForLive,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";
import { captureRealtime, countWorkspaceRequests } from "./helpers/realtime";

/**
 * The workspace over a real local Supabase Realtime socket.
 *
 * Realtime-vs-polling is proven structurally, not by timing guesses: a
 * `postgres_changes` frame on the intercepted socket can only come from
 * WebSocket, and before asserting on re-reads each test first observes the
 * app's 20-second poll so any workspace read that follows within a few
 * seconds is known to be event-driven — the next poll is ~20s away.
 */
test.describe("realtime in the browser", () => {
  /**
   * Waits (bounded) until a workspace re-read is observed while nothing is
   * happening — i.e. the periodic poll itself — which fixes the poll phase
   * so later reads can be attributed to realtime events.
   */
  async function observePollPhase(reads: () => number): Promise<number> {
    await expect.poll(reads, { timeout: 21_000 }).toBeGreaterThan(0);
    return reads();
  }

  test("a session started by the owner reaches the member over WebSocket, without a reload", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const capture = await captureRealtime(member);

    try {
      await signUpAndOnboard(owner, "rt-owner");
      const room = await createRoomViaUi(owner, { label: "rt", capacity: 4 });
      await waitForLive(owner);

      await signUpAndOnboard(member, "rt-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      const workspaceReads = countWorkspaceRequests(member);
      let fullLoads = 0;
      member.on("load", () => {
        fullLoads += 1;
      });

      // Establish the poll phase: the next scheduled poll is now ~20s away,
      // so any read triggered after the click can only be event-driven.
      const phase = await observePollPhase(workspaceReads);
      expect(workspaceReads()).toBe(phase);

      const clickedAt = Date.now();
      await focusTimer(owner).getByRole("button", { name: "Start 25 min session" }).click();

      // 1. The change itself crosses the WebSocket: a postgres_changes
      // INSERT frame arrives for this room — polling cannot produce one.
      await expect
        .poll(
          () =>
            capture
              .events()
              .filter(
                (event) => event.type === "INSERT" && event.record.room_id === room.id,
              ).length,
          { timeout: 8_000 },
        )
        .toBeGreaterThan(0);
      expect(Date.now() - clickedAt).toBeLessThan(8_000);

      // 2. The member's UI reflects the session inside the realtime window,
      // far faster than the 20-second poll, and re-read the workspace — the
      // next poll is nowhere near this window.
      await expect(focusTimer(member).getByText("running", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      expect(Date.now() - clickedAt).toBeLessThan(10_000);
      expect(workspaceReads()).toBeGreaterThan(phase);

      // 3. Nothing reloaded: this was a client-side update only.
      expect(fullLoads).toBe(0);
      expect(await syncStatus(member).innerText()).toBe("Live");
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("a dropped socket reports itself and recovers with the state intact", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "rec-owner");
      const room = await createRoomViaUi(owner, { label: "recovery", capacity: 4 });
      await startSession(owner, 25);
      await waitForLive(owner);

      await signUpAndOnboard(member, "rec-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);
      await expect(focusTimer(member).getByText("running", { exact: true })).toBeVisible();

      // The socket dies: the UI must say so instead of pretending to be live.
      await memberContext.setOffline(true);
      await expect(syncStatus(member)).toHaveText(/Reconnecting…|Connecting…/, {
        timeout: 20_000,
      });

      // The world moves on while the member is cut off.
      await focusTimer(owner).getByRole("button", { name: "Pause", exact: true }).click();
      await expect(focusTimer(owner).getByText("paused", { exact: true })).toBeVisible();

      // Back online: the subscription re-establishes ("Live") and the missed
      // state shows up — via the re-joined channel or the poll, both part of
      // the recovery contract.
      await memberContext.setOffline(false);
      await expect(syncStatus(member)).toHaveText("Live", { timeout: 30_000 });
      await expect(focusTimer(member).getByText("paused", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("stale and duplicate realtime frames cannot corrupt the view", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const capture = await captureRealtime(member);

    try {
      await signUpAndOnboard(owner, "stale-owner");
      const room = await createRoomViaUi(owner, { label: "stale", capacity: 4 });
      await waitForLive(owner);

      await signUpAndOnboard(member, "stale-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      // Run one full session so real INSERT and UPDATE frames are on record.
      await startSession(owner, 25);
      await expect(focusTimer(member).getByText("running", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await focusTimer(owner).getByRole("button", { name: "End session" }).click();
      await expect(focusTimer(member).getByText("completed", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      const staleInsert = capture.insertFrame(room.id);

      const workspaceReads = countWorkspaceRequests(member);

      // Quiet period: observe the poll so every read below can be attributed
      // to the injected frames rather than to the 20-second schedule.
      await expect
        .poll(workspaceReads, { timeout: 21_000 })
        .toBeGreaterThan(0);
      let reads = workspaceReads();

      // The old INSERT arrives after its UPDATE — out of order, as a delayed
      // or replayed frame would be. The client re-reads canonical state and
      // the finished session stays finished.
      capture.inject(staleInsert.raw);
      await expect.poll(workspaceReads, { timeout: 4_000 }).toBeGreaterThan(reads);
      await expect(focusTimer(member).getByText("running", { exact: true })).toHaveCount(0);
      await expect(focusTimer(member).getByText("No session running.")).toBeVisible();
      await expect(focusTimer(member).getByText("completed", { exact: true })).toHaveCount(1);

      // The same frame again — a duplicate delivery. One re-read, same truth:
      // still a single completed row, still no phantom session.
      reads = workspaceReads();
      capture.inject(staleInsert.raw);
      await expect.poll(workspaceReads, { timeout: 4_000 }).toBeGreaterThan(reads);
      await expect(focusTimer(member).getByText("running", { exact: true })).toHaveCount(0);
      await expect(focusTimer(member).getByText("completed", { exact: true })).toHaveCount(1);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });
});
