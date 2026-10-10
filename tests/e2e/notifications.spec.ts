import { expect, test, type Page } from "@playwright/test";
import { createRoomViaUi } from "./helpers/rooms";
import { signUpAndOnboard, waitForHydration, type E2EUser } from "./helpers/users";

/**
 * The notification bell end to end (PR 11): an invite produced by the real
 * invitation route increments the invitee's badge in an open tab without a
 * manual reload, a click deep-links and decrements it, "Mark all read"
 * clears the badge durably, preferences suppress a *new* producer write at
 * the source, signed-out visitors never meet the bell, and the header
 * control stays usable at a phone viewport. The channel behind the live
 * update is proven separately in realtime.spec.ts; here the assertion is
 * the student-visible outcome.
 */

const PHONE = { width: 375, height: 812 };

function invitePanel(page: Page, roomId: string) {
  return page.getByRole("region", { name: "Invite a student" }).filter({
    has: page.locator(`#invite-alias-${roomId}`),
  });
}

async function sendInvitation(page: Page, roomId: string, alias: string) {
  const panel = invitePanel(page, roomId);
  await expect(panel.getByRole("heading", { name: "Invite a student" })).toBeVisible();
  await panel.locator(`#invite-alias-${roomId}`).fill(alias);
  await panel.getByRole("button", { name: "Send invitation" }).click();
  await expect(panel.getByText(`Invitation sent to ${alias}.`)).toBeVisible();
}

function bell(page: Page) {
  return page.getByTestId("notification-bell");
}

function badge(page: Page) {
  return page.getByTestId("notification-badge");
}

function aliasOf(user: E2EUser): string {
  if (!user.alias) {
    throw new Error(`No alias recorded for ${user.email}`);
  }
  return user.alias;
}

async function openBellDropdown(page: Page) {
  await bell(page).click();
  await expect(page.getByTestId("notification-panel")).toBeVisible();
}

/**
 * Converges the badge on `expected` without a reload. The live channel
 * usually delivers first, but under full-suite load its join can still be in
 * flight, and a mark-read POST can still be travelling while the deep-link
 * navigation lands — both are product-supported states ("the next wakeup
 * re-syncs"), so the poll re-dispatches the focus event the tab already
 * listens on until the badge matches. The polling fallback is a shipped
 * mechanism, not a reload the test invents.
 */
async function expectBadge(page: Page, expected: number) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        const count = await badge(page).count();
        if (expected === 0) {
          return count;
        }
        if (count === 0) {
          return -1;
        }
        return Number(await badge(page).textContent());
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(expected);
}

test("live invite, deep link, mark-all, and preference suppression", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    await signUpAndOnboard(ownerPage, "notif-owner");
    const guest = await signUpAndOnboard(guestPage, "notif-guest");

    // Both tabs sit on discovery, bells mounted, while the owner invites
    // from a private workspace three separate times below.
    await guestPage.goto("/rooms");
    await expect(bell(guestPage)).toBeVisible();

    const firstRoom = await createRoomViaUi(ownerPage, {
      label: "notif-one",
      capacity: 3,
      visibility: "private",
    });
    await sendInvitation(ownerPage, firstRoom.id, aliasOf(guest));

    // The badge arrives in the already-open guest tab without a reload.
    await expectBadge(guestPage, 1);

    // Click-through: the dropdown row deep-links to /invitations, marks the
    // row read, and the badge decrements with it. The mark-read POST races
    // the navigation by design (the deep link never waits on it), so the
    // badge is converged through the wakeup — exactly how the product
    // re-syncs after a landing render that predated the write.
    await openBellDropdown(guestPage);
    const row = guestPage
      .getByTestId("notification-row")
      .filter({ hasText: firstRoom.name });
    await expect(row).toBeVisible();
    await row.click();
    await guestPage.waitForURL(/\/invitations$/);
    await expectBadge(guestPage, 0);

    // The read is durable: the inbox page lists the row as read.
    await guestPage.goto("/notifications");
    const readRow = guestPage
      .getByTestId("notification-row")
      .filter({ hasText: firstRoom.name });
    await expect(readRow).toBeVisible();
    await expect(readRow).toHaveAttribute("data-unread", "false");

    // Mark all read: a second invite raises the badge, then one click clears
    // it, and a fresh document still shows it cleared. The guest page was
    // just remounted by the goto above, so its live channel may still be
    // joining when the invite lands; expectBadge converges it without a
    // reload (server-side confirm + the focus wakeup the tab listens on).
    const secondRoom = await createRoomViaUi(ownerPage, {
      label: "notif-two",
      capacity: 3,
      visibility: "private",
    });
    await guestPage.goto("/rooms");
    await expect(bell(guestPage)).toBeVisible();
    await sendInvitation(ownerPage, secondRoom.id, aliasOf(guest));
    await expectBadge(guestPage, 1);
    await openBellDropdown(guestPage);
    await guestPage.getByTestId("notifications-mark-all").click();
    await expect(badge(guestPage)).toHaveCount(0);
    // Same POST-vs-navigation race as the click-through: the reload can
    // land before read-all finishes, so the badge converges via wakeup.
    await guestPage.reload();
    await expect(bell(guestPage)).toBeVisible();
    await expectBadge(guestPage, 0);

    // Preferences: the guest turns invitations off, the owner sends a third
    // invite through the same real producer, and nothing appears — no badge,
    // no list row — because the write was suppressed at the source.
    await guestPage.goto("/notifications");
    await waitForHydration(guestPage, "#pref-invite");
    await guestPage.locator("#pref-invite").selectOption("none");
    await guestPage.getByRole("button", { name: "Save preferences" }).click();
    await expect(guestPage.getByTestId("prefs-status")).toHaveText(
      "Preferences saved.",
    );

    const thirdRoom = await createRoomViaUi(ownerPage, {
      label: "notif-three",
      capacity: 3,
      visibility: "private",
    });
    await sendInvitation(ownerPage, thirdRoom.id, aliasOf(guest));

    await guestPage.reload();
    await expect(bell(guestPage)).toBeVisible();
    await expect(badge(guestPage)).toHaveCount(0);
    await expect(
      guestPage
        .getByTestId("notification-row")
        .filter({ hasText: thirdRoom.name }),
    ).toHaveCount(0);
    // The suppressed invite never becomes a row, while the earlier ones
    // remain listed and read.
    await expect(
      guestPage
        .getByTestId("notification-row")
        .filter({ hasText: secondRoom.name }),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test("a signed-out visitor never sees the bell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("notification-bell")).toHaveCount(0);
  await page.goto("/auth/login");
  await expect(page.getByTestId("notification-bell")).toHaveCount(0);
});

test.describe("phone viewport", () => {
  test.use({ viewport: PHONE });

  test("the bell is visible and its dropdown is operable", async ({ page }) => {
    const user = await signUpAndOnboard(page, "notif-phone");

    // The bell lives in the header itself, so it survives the md: collapse
    // that hides the inline nav and the account controls.
    await expect(bell(page)).toBeVisible();

    // An invite raises the badge at this width too — the owner invites from
    // a second browser the same way the desktop flow does.
    const ownerContext = await page.context().browser()!.newContext();
    const ownerPage = await ownerContext.newPage();
    try {
      await signUpAndOnboard(ownerPage, "notif-phone-owner");
      const room = await createRoomViaUi(ownerPage, {
        label: "notif-phone",
        capacity: 3,
        visibility: "private",
      });
      await sendInvitation(ownerPage, room.id, aliasOf(user));

      await expectBadge(page, 1);
      await openBellDropdown(page);
      const row = page
        .getByTestId("notification-row")
        .filter({ hasText: room.name });
      await expect(row).toBeVisible();
      await row.click();
      await page.waitForURL(/\/invitations$/);
      await expectBadge(page, 0);
    } finally {
      await ownerContext.close();
    }
  });
});
