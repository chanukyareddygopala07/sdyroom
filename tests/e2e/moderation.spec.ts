import { expect, test, type Page } from "@playwright/test";
import {
  chatPanel,
  createRoomViaUi,
  enterRoomViaUi,
  joinRoomViaUi,
  searchRooms,
  waitForLive,
} from "./helpers/rooms";
import { signUpAndOnboard, type E2EUser } from "./helpers/users";

/**
 * Member safety end to end: reports reach the owner's moderation inbox
 * without ever carrying the reporter's identity, blocks hide messages
 * one-way with no trace for the blocked, the owner can mute and remove
 * through the roster, and direct API attempts are refused with exactly the
 * documented error codes.
 */

/** The alias is chosen during onboarding; every locator below needs it. */
function aliasOf(user: E2EUser): string {
  if (!user.alias) {
    throw new Error(`expected ${user.email} to have completed onboarding`);
  }
  return user.alias;
}

function roster(page: Page) {
  return page.getByRole("region", { name: "Members" });
}

function inbox(page: Page) {
  return page.getByRole("region", { name: "Moderation" });
}

async function openMemberMenu(page: Page, alias: string): Promise<void> {
  await roster(page)
    .getByRole("button", { name: `Actions for ${alias}` })
    .click();
}

/** Signs the member up, finds the room in discovery, and enters the workspace. */
async function joinAsMember(
  page: Page,
  roomName: string,
  label: string,
): Promise<E2EUser> {
  const member = await signUpAndOnboard(page, label);
  await searchRooms(page, roomName);
  await joinRoomViaUi(page, roomName);
  await enterRoomViaUi(page, roomName);
  await waitForLive(page);
  return member;
}

test.describe("moderation and member safety", () => {
  test("a member reports a message and the owner works it through the inbox", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      const ownerUser = await signUpAndOnboard(owner, "report-owner");
      const ownerAlias = aliasOf(ownerUser);
      const room = await createRoomViaUi(owner, { label: "reported" });
      await waitForLive(owner);
      const memberUser = await joinAsMember(
        member,
        room.name,
        "report-member",
      );
      const memberAlias = aliasOf(memberUser);

      // The owner says something worth reporting.
      await chatPanel(owner)
        .getByRole("textbox", { name: "Message" })
        .fill("Take my weekend crash course now");
      await chatPanel(owner).getByRole("button", { name: "Send" }).click();
      await expect(
        chatPanel(member).locator("li", {
          hasText: "Take my weekend crash course now",
        }),
      ).toBeVisible({ timeout: 15_000 });

      // The member files the report from the message itself.
      await chatPanel(member)
        .getByRole("button", {
          name: `Report message from ${ownerAlias}`,
        })
        .click();
      const dialog = member.getByRole("dialog", {
        name: "Report this message",
      });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: "Harassment" }).click();
      await dialog.getByLabel("Detail (optional)").fill("Third ad today.");
      await dialog.getByRole("button", { name: "Send report" }).click();
      await expect(dialog).toHaveText(/your report was sent/i);
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(member.getByRole("dialog")).toHaveCount(0);

      // A plain member has no moderation surface at all.
      await expect(inbox(member)).toHaveCount(0);

      // The owner's inbox carries the report — and never the reporter.
      await owner.reload();
      await expect(inbox(owner)).toBeVisible();
      await expect(inbox(owner)).toHaveText(/1 report/);
      const card = inbox(owner).getByRole("listitem").first();
      await expect(card).toContainText("Harassment");
      await expect(card).toContainText("about message ");
      await expect(card).toContainText("Pending");
      await expect(card).not.toContainText(memberAlias);

      // The workflow advances and the resolver is named.
      await card.getByRole("button", { name: "Start review" }).click();
      await expect(card).toContainText("Reviewing");
      await expect(
        card.getByRole("button", { name: "Start review" }),
      ).toHaveCount(0);
      await card.getByRole("button", { name: "Resolve" }).click();
      await expect(card).toContainText("Resolved");
      await expect(card).toContainText(`by ${ownerAlias}`);
      await expect(card.getByRole("button", { name: "Resolve" })).toHaveCount(
        0,
      );
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("blocking hides the other side's messages one-way and leaves no trace", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      const ownerUser = await signUpAndOnboard(owner, "block-owner");
      const ownerAlias = aliasOf(ownerUser);
      const room = await createRoomViaUi(owner, { label: "blocked" });
      await waitForLive(owner);
      const memberUser = await joinAsMember(member, room.name, "block-member");
      const memberAlias = aliasOf(memberUser);

      // The owner speaks before the block; the member sees it live.
      await chatPanel(owner)
        .getByRole("textbox", { name: "Message" })
        .fill("Buy my weekend crash course");
      await chatPanel(owner).getByRole("button", { name: "Send" }).click();
      await expect(
        chatPanel(member).locator("li", { hasText: "Buy my weekend crash course" }),
      ).toBeVisible({ timeout: 15_000 });

      // The member blocks the owner from the roster.
      await openMemberMenu(member, ownerAlias);
      await member
        .getByRole("menuitem", { name: "Block", exact: true })
        .click();
      await openMemberMenu(member, ownerAlias);
      await expect(
        member.getByRole("menuitem", { name: "Unblock", exact: true }),
      ).toBeVisible();

      // After a reload the owner's history is gone for the blocker only…
      await member.reload();
      await expect(
        chatPanel(member).locator("li", { hasText: "Buy my weekend crash course" }),
      ).toHaveCount(0);

      // …while the member can still speak, and the owner still hears it.
      await chatPanel(member)
        .getByRole("textbox", { name: "Message" })
        .fill("still shouting");
      await chatPanel(member).getByRole("button", { name: "Send" }).click();
      await expect(
        chatPanel(member).locator("li", { hasText: "still shouting" }),
      ).toBeVisible();
      await owner.reload();
      await expect(
        chatPanel(owner).locator("li", { hasText: "still shouting" }),
      ).toBeVisible({ timeout: 15_000 });

      // The owner is never told they were blocked: their view is unchanged.
      await openMemberMenu(owner, memberAlias);
      await expect(
        owner.getByRole("menuitem", { name: "Block", exact: true }),
      ).toBeVisible();
      await expect(
        owner.getByRole("menuitem", { name: "Unblock", exact: true }),
      ).toHaveCount(0);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("an owner mutes a member, then removes them from the room", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "mute-owner");
      const room = await createRoomViaUi(owner, { label: "muted" });
      await waitForLive(owner);
      const memberUser = await joinAsMember(member, room.name, "mute-member");
      const memberAlias = aliasOf(memberUser);

      await chatPanel(member)
        .getByRole("textbox", { name: "Message" })
        .fill("here now");
      await chatPanel(member).getByRole("button", { name: "Send" }).click();
      await expect(
        chatPanel(member).locator("li", { hasText: "here now" }),
      ).toBeVisible();

      // The owner's roster was rendered before this member took a seat, so
      // the workspace is reloaded to read the membership from server truth.
      await owner.reload();
      await expect(
        roster(owner).locator("li").filter({ hasText: memberAlias }),
      ).toBeVisible();

      // The owner mutes for an hour from the member's menu.
      await openMemberMenu(owner, memberAlias);
      await owner.getByRole("menuitem", { name: "Mute for 1 hour" }).click();
      const memberRow = roster(owner)
        .locator("li")
        .filter({ hasText: memberAlias });
      await expect(memberRow.getByText("muted", { exact: true })).toBeVisible();

      // The member's own reload enforces it: the composer is gone.
      await member.reload();
      const composer = chatPanel(member).getByRole("textbox", {
        name: "Message",
      });
      await expect(composer).toBeDisabled();
      await expect(chatPanel(member)).toHaveText(
        /You are muted in this room until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/,
      );

      // The owner's menu now offers Unmute instead of the durations…
      await openMemberMenu(owner, memberAlias);
      await expect(owner.getByRole("menuitem", { name: "Unmute" })).toBeVisible();
      await owner.keyboard.press("Escape");

      // …and removal is still behind the deliberate confirmation.
      await openMemberMenu(owner, memberAlias);
      await owner.getByRole("menuitem", { name: "Remove from room…" }).click();
      const confirm = owner.getByRole("alertdialog");
      await expect(confirm).toContainText(
        `Remove ${memberAlias} from this room?`,
      );
      await confirm.getByRole("button", { name: "Remove member" }).click();
      await expect(owner.getByRole("alertdialog")).toHaveCount(0);
      await expect(
        roster(owner).locator("li").filter({ hasText: memberAlias }),
      ).toHaveCount(0);

      // The seat is gone: the member's workspace URL is now a 404.
      await member.goto(`/rooms/${room.id}`);
      await expect(
        member.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("direct API attempts are refused with the documented error codes", async ({
    browser,
    request,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const outsiderContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const outsider = await outsiderContext.newPage();

    try {
      const ownerUser = await signUpAndOnboard(owner, "api-owner");
      const ownerAlias = aliasOf(ownerUser);
      const room = await createRoomViaUi(owner, { label: "guarded" });
      const memberUser = await joinAsMember(member, room.name, "api-member");
      const memberAlias = aliasOf(memberUser);
      await signUpAndOnboard(outsider, "api-outsider");

      // Anonymous callers never get past the session gate.
      const anonReport = await request.post(
        `/api/rooms/${room.id}/reports`,
        { data: { subject_type: "user", subject_alias: ownerAlias, reason: "spam" } },
      );
      expect(anonReport.status()).toBe(401);
      expect((await anonReport.json()).error.code).toBe("unauthenticated");
      const anonBlock = await request.post("/api/blocks", {
        data: { alias: ownerAlias },
      });
      expect(anonBlock.status()).toBe(401);
      expect((await anonBlock.json()).error.code).toBe("unauthenticated");

      // A signed-in stranger cannot even prove the room's existence…
      const outsiderReport = await outsiderContext.request.post(
        `/api/rooms/${room.id}/reports`,
        { data: { subject_type: "user", subject_alias: ownerAlias, reason: "spam" } },
      );
      expect(outsiderReport.status()).toBe(404);
      expect((await outsiderReport.json()).error.code).toBe("not_found");
      const outsiderList = await outsiderContext.request.get(
        `/api/rooms/${room.id}/reports`,
      );
      expect(outsiderList.status()).toBe(404);
      expect((await outsiderList.json()).error.code).toBe("not_found");

      // …and a plain member who files a report still holds no moderator keys.
      const filed = await memberContext.request.post(
        `/api/rooms/${room.id}/reports`,
        { data: { subject_type: "user", subject_alias: ownerAlias, reason: "spam" } },
      );
      expect(filed.status()).toBe(201);
      const reportId = (await filed.json()).report.id as string;

      const memberList = await memberContext.request.get(
        `/api/rooms/${room.id}/reports`,
      );
      expect(memberList.status()).toBe(403);
      expect((await memberList.json()).error.code).toBe("not_moderator");

      // The report id is opaque and the room never enters this path: a
      // plain member gets the same 404 a missing id gets, so the endpoint
      // cannot be used as an existence oracle.
      const memberPatch = await memberContext.request.patch(
        `/api/reports/${reportId}`,
        { data: { status: "reviewing" } },
      );
      expect(memberPatch.status()).toBe(404);
      expect((await memberPatch.json()).error.code).toBe("not_found");

      const memberMute = await memberContext.request.post(
        `/api/rooms/${room.id}/members/${ownerAlias}/mute`,
        { data: { duration: "1h" } },
      );
      expect(memberMute.status()).toBe(403);
      expect((await memberMute.json()).error.code).toBe("not_moderator");

      // The owner is a moderator — but cannot mute themselves.
      const selfMute = await ownerContext.request.post(
        `/api/rooms/${room.id}/members/${ownerAlias}/mute`,
        { data: { duration: "1h" } },
      );
      expect(selfMute.status()).toBe(403);
      expect((await selfMute.json()).error.code).toBe("cannot_mute_self");

      // The owner's own inbox read carries no reporter identity to leak.
      const ownerList = await ownerContext.request.get(
        `/api/rooms/${room.id}/reports`,
      );
      expect(ownerList.status()).toBe(200);
      const ownerBody = await ownerList.text();
      expect(ownerBody).not.toContain(memberAlias);
      expect(ownerBody).not.toContain("reporter_id");
      const parsed = JSON.parse(ownerBody) as {
        reports: { id: string; status: string }[];
        count: number;
      };
      expect(parsed.count).toBe(1);
      expect(parsed.reports[0]?.id).toBe(reportId);
    } finally {
      await ownerContext.close();
      await memberContext.close();
      await outsiderContext.close();
    }
  });
});
