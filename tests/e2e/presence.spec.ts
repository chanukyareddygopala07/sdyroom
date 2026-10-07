import { expect, test, type BrowserContext } from "@playwright/test";
import { presenceChannelTopic } from "../../lib/chat/presence";
import { psql } from "../integration/helpers/admin";
import {
  captureRealtime,
  type RealtimeCapture,
} from "./helpers/realtime";
import {
  chatPanel,
  chatStatus,
  createRoomViaUi,
  enterRoomViaUi,
  focusTimer,
  joinRoomViaUi,
  presenceCount,
  participantBadges,
  searchRooms,
  startSession,
  waitForLive,
} from "./helpers/rooms";
import { login, signUpAndOnboard, type E2EUser } from "./helpers/users";

/**
 * Room presence over the real local Supabase stack: two browsers in one
 * room seeing each other, a closed browser disappearing from the roster, a
 * reopen restoring it, a private room staying member-only, and `studying`
 * following the shared focus session.
 *
 * The waits are frame-based, not sleeps: `captureRealtime` records every
 * server→page frame, and each step first waits for the `presence_diff` /
 * `presence_state` frame that carried the change (joins, leaves, a studying
 * flip) before asserting what the roster renders from it — per
 * tests/e2e/README.md "Proving realtime instead of guessing".
 */

function aliasOf(user: E2EUser): string {
  if (!user.alias) {
    throw new Error(`No alias recorded for ${user.email}`);
  }
  return user.alias;
}

/** True once any frame after `since` joined `alias` (optionally studying). */
function joinedAfter(
  capture: RealtimeCapture,
  topic: string,
  since: number,
  alias: string,
  studying?: boolean,
): boolean {
  return capture
    .presenceFrames(topic)
    .slice(since)
    .some((frame) =>
      frame.joins.some(
        (entry) =>
          entry.alias === alias &&
          (studying === undefined || entry.studying === studying),
      ),
    );
}

/** True once any frame after `since` dropped `alias`. */
function leftAfter(
  capture: RealtimeCapture,
  topic: string,
  since: number,
  alias: string,
): boolean {
  return capture
    .presenceFrames(topic)
    .slice(since)
    .some((frame) =>
      frame.leaves.some((entry) => entry.alias === alias),
    );
}

/**
 * Adds an existing account to a room with admin SQL. Private rooms have no
 * discovery path into them and an invite flow is explicitly out of scope,
 * so the membership itself is setup — what is under test is the presence
 * that follows it.
 */
function addMemberViaSql(roomId: string, email: string): void {
  const userId = psql(
    `select id from auth.users where email = '${email}';`,
  )
    .split("\n")[0]
    ?.trim();
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error(`No auth user found for ${email}`);
  }
  psql(
    `insert into public.room_members (room_id, user_id, role) ` +
      `values ('${roomId}', '${userId}', 'student') on conflict do nothing;`,
  );
}

async function closeQuietly(context: BrowserContext | null): Promise<void> {
  await context?.close().catch(() => undefined);
}

test.describe("room presence in the browser", () => {
  test("two members see each other; closing one removes it, reopening restores it", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const captureOwner = await captureRealtime(owner);
    let reopened: BrowserContext | null = null;

    try {
      const ownerUser = await signUpAndOnboard(owner, "presence-owner");
      const room = await createRoomViaUi(owner, {
        label: "presence",
        capacity: 4,
      });
      await waitForLive(owner);

      const memberUser = await signUpAndOnboard(member, "presence-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      const topic = presenceChannelTopic(room.id);

      // The member's join crosses the socket first; only then does the
      // roster claim to know who is here.
      await expect
        .poll(
          () =>
            joinedAfter(captureOwner, topic, 0, aliasOf(memberUser), false),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(presenceCount(owner)).toHaveText("2 here", {
        timeout: 15_000,
      });
      await expect(presenceCount(member)).toHaveText("2 here", {
        timeout: 15_000,
      });
      // Own alias first on each side — the same two people, ordered per viewer.
      expect(await participantBadges(owner).allTextContents()).toEqual([
        aliasOf(ownerUser),
        aliasOf(memberUser),
      ]);
      expect(await participantBadges(member).allTextContents()).toEqual([
        aliasOf(memberUser),
        aliasOf(ownerUser),
      ]);
      expect(await chatStatus(member).innerText()).toBe("Live");

      // Closing the member's browser: the leave frame is the proof, the
      // roster drop is the assertion — both inside the 15 s cleanup bound.
      const framesBeforeLeave = captureOwner.presenceFrames(topic).length;
      await memberContext.close();
      await expect
        .poll(
          () =>
            leftAfter(captureOwner, topic, framesBeforeLeave, aliasOf(memberUser)),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(presenceCount(owner)).toHaveText("1 here", {
        timeout: 15_000,
      });
      await expect(participantBadges(owner)).toHaveText([
        aliasOf(ownerUser),
      ]);

      // Reopening: same account, fresh socket — an identical list, no
      // ghosts of the departed connection and no duplicates.
      reopened = await browser.newContext();
      const memberAgain = await reopened.newPage();
      await login(memberAgain, memberUser);
      await searchRooms(memberAgain, room.name);
      await enterRoomViaUi(memberAgain, room.name);
      await waitForLive(memberAgain);

      const framesBeforeReturn = captureOwner.presenceFrames(topic).length;
      await expect
        .poll(
          () =>
            joinedAfter(
              captureOwner,
              topic,
              framesBeforeReturn,
              aliasOf(memberUser),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(presenceCount(owner)).toHaveText("2 here", {
        timeout: 15_000,
      });
      expect(await participantBadges(owner).allTextContents()).toEqual([
        aliasOf(ownerUser),
        aliasOf(memberUser),
      ]);
      await expect(presenceCount(memberAgain)).toHaveText("2 here", {
        timeout: 15_000,
      });
      expect(await participantBadges(memberAgain).allTextContents()).toEqual([
        aliasOf(memberUser),
        aliasOf(ownerUser),
      ]);
    } finally {
      await closeQuietly(reopened);
      await ownerContext.close();
      await closeQuietly(memberContext);
    }
  });

  test("a private room's roster is member-only; a non-member gets the 404 and never joins", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const outsiderContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const outsider = await outsiderContext.newPage();
    const captureOwner = await captureRealtime(owner);
    // Registered before the outsider's first navigation, so any presence
    // join — if one ever slipped through — would be on record.
    const captureOutsider = await captureRealtime(outsider);

    try {
      const ownerUser = await signUpAndOnboard(owner, "presence-priv-owner");
      const room = await createRoomViaUi(owner, {
        label: "presence-private",
        capacity: 4,
        visibility: "private",
      });
      await waitForLive(owner);

      const memberUser = await signUpAndOnboard(member, "presence-priv-member");
      addMemberViaSql(room.id, memberUser.email);
      await member.goto(`/rooms/${room.id}`);
      await expect(
        member.getByRole("heading", { level: 1, name: room.name }),
      ).toBeVisible();
      await waitForLive(member);

      const topic = presenceChannelTopic(room.id);
      await expect
        .poll(
          () =>
            joinedAfter(captureOwner, topic, 0, aliasOf(memberUser), false),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(presenceCount(owner)).toHaveText("2 here", {
        timeout: 15_000,
      });
      await expect(presenceCount(member)).toHaveText("2 here", {
        timeout: 15_000,
      });
      expect(await participantBadges(member).allTextContents()).toEqual([
        aliasOf(memberUser),
        aliasOf(ownerUser),
      ]);

      // A signed-in non-member: the workspace 404s exactly like a room that
      // never existed, and the roster that would have leaked its existence
      // is simply not there.
      const outsiderUser = await signUpAndOnboard(
        outsider,
        "presence-priv-outsider",
      );
      await outsider.goto(`/rooms/${room.id}`);
      await expect(
        outsider.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();
      await outsider.goto(
        "/rooms/00000000-0000-4000-8000-000000000000",
      );
      await expect(
        outsider.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();

      await expect(chatPanel(outsider)).toHaveCount(0);
      await expect(presenceCount(outsider)).toHaveCount(0);
      await expect(participantBadges(outsider)).toHaveCount(0);
      // And no socket ever asked to join this room's presence channel.
      expect(captureOutsider.presenceFrames(topic)).toHaveLength(0);
      expect(
        captureOutsider
          .presenceFrames()
          .filter((frame) => frame.topic.startsWith("room-presence-")),
      ).toHaveLength(0);
      expect(outsiderUser.email).toBeTruthy();
    } finally {
      await ownerContext.close();
      await memberContext.close();
      await outsiderContext.close();
    }
  });

  test("studying follows the shared session: on when it starts, off when it ends", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const captureMember = await captureRealtime(member);

    try {
      const ownerUser = await signUpAndOnboard(owner, "presence-st-owner");
      const room = await createRoomViaUi(owner, {
        label: "presence-study",
        capacity: 4,
      });
      await waitForLive(owner);

      const memberUser = await signUpAndOnboard(member, "presence-st-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      const topic = presenceChannelTopic(room.id);
      await expect(presenceCount(member)).toHaveText("2 here", {
        timeout: 15_000,
      });
      await expect(participantBadges(member).filter({ hasText: "studying" })).toHaveCount(0);

      // The start crosses the socket as a studying=true re-track.
      const beforeStart = captureMember.presenceFrames(topic).length;
      await startSession(owner, 25);
      await expect
        .poll(
          () =>
            joinedAfter(
              captureMember,
              topic,
              beforeStart,
              aliasOf(ownerUser),
              true,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(presenceCount(member)).toHaveText("2 studying · 2 here", {
        timeout: 15_000,
      });
      await expect(presenceCount(owner)).toHaveText("2 studying · 2 here", {
        timeout: 15_000,
      });
      expect(await participantBadges(member).allTextContents()).toEqual([
        `${aliasOf(memberUser)} · studying`,
        `${aliasOf(ownerUser)} · studying`,
      ]);

      // Ending it re-tracks both clients back to false.
      const beforeEnd = captureMember.presenceFrames(topic).length;
      await focusTimer(owner)
        .getByRole("button", { name: "End session" })
        .click();
      await expect
        .poll(
          () =>
            joinedAfter(
              captureMember,
              topic,
              beforeEnd,
              aliasOf(ownerUser),
              false,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(presenceCount(member)).toHaveText("2 here", {
        timeout: 15_000,
      });
      await expect(presenceCount(owner)).toHaveText("2 here", {
        timeout: 15_000,
      });
      expect(await participantBadges(owner).allTextContents()).toEqual([
        aliasOf(ownerUser),
        aliasOf(memberUser),
      ]);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });
});
