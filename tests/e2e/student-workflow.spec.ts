import { expect, test } from "@playwright/test";
import {
  createRoomViaUi,
  enterRoomViaUi,
  focusTimer,
  goalsPanel,
  joinRoomViaUi,
  leaveRoomViaUi,
  searchRooms,
  startSession,
  syncStatus,
  waitForLive,
  clock,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * The full student workflow in real browsers: two independent contexts, two
 * students, no API-level shortcuts. Every wait is an assertion against
 * observable UI state — no fixed sleeps.
 */
test("student registers, runs a focused room with a member, and manages goals", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  try {
    // 1–2. Registration and onboarding through the real forms.
    await signUpAndOnboard(owner, "flow-owner");

    // 3. Create a room; the app lands in its workspace.
    const room = await createRoomViaUi(owner, { label: "flow", capacity: 4 });
    await waitForLive(owner);

    // 4. Start the shared 25-minute session with a server-synced countdown.
    await startSession(owner, 25);
    const countdown = clock(owner);
    const firstReading = await countdown.innerText();
    expect(firstReading).toMatch(/^(25:00|2[0-4]:\d{2})$/);
    // The clock ticks down from server time, not from a static string.
    await expect
      .poll(async () => countdown.innerText(), { timeout: 15_000 })
      .not.toBe(firstReading);

    // 5–6. A second student registers, discovers the room and joins it.
    await signUpAndOnboard(member, "flow-member");
    await searchRooms(member, room.name);
    await joinRoomViaUi(member, room.name);

    // 7. Enters the workspace and observes the synchronized running timer —
    // without ever owning the controls.
    await enterRoomViaUi(member, room.name);
    await waitForLive(member);
    await expect(focusTimer(member).getByText("running", { exact: true })).toBeVisible();
    await expect(
      focusTimer(member).getByText("The room owner controls this timer."),
    ).toBeVisible();
    await expect(
      focusTimer(member).getByRole("button", { name: "End session" }),
    ).toHaveCount(0);

    // 8. Owner pauses and resumes; the member's view follows while both tabs
    // stay open (bounded waits — the update must arrive on its own).
    await focusTimer(owner).getByRole("button", { name: "Pause", exact: true }).click();
    await expect(focusTimer(member).getByText("paused", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await focusTimer(owner).getByRole("button", { name: "Resume" }).click();
    await expect(
      focusTimer(member).getByText("running", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(await syncStatus(member).innerText()).toBe("Live");

    // 9. The member adds and completes a personal goal; the owner's fresh
    // server render never contains it.
    const goalTitle = `Finish problem set ${Date.now()}`;
    await goalsPanel(member).getByLabel("Goal title").fill(goalTitle);
    await goalsPanel(member).getByRole("button", { name: "Add goal" }).click();
    await expect(goalsPanel(member).getByText(goalTitle)).toBeVisible();
    await goalsPanel(member).getByRole("button", { name: "Complete", exact: true }).click();
    await expect(goalsPanel(member).getByText("completed", { exact: true })).toBeVisible();

    await owner.reload();
    await expect(goalsPanel(owner).getByText(goalTitle)).toHaveCount(0);
    await expect(goalsPanel(owner).getByText("No goals yet")).toBeVisible();

    // 10. Ending the session records history on both sides; the member then
    // leaves the room and loses workspace access, while the owner keeps it.
    await focusTimer(owner).getByRole("button", { name: "End session" }).click();
    await expect(focusTimer(owner).getByText("completed", { exact: true })).toBeVisible();
    await expect(focusTimer(member).getByText("completed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(focusTimer(member).getByText("No session running.")).toBeVisible();

    const workspaceUrl = new URL(member.url()).pathname;
    await searchRooms(member, room.name);
    await leaveRoomViaUi(member, room.name);
    await member.goto(workspaceUrl);
    await expect(member.getByRole("heading", { name: "Page not found" })).toBeVisible();

    await owner.goto(workspaceUrl);
    await expect(owner.getByRole("heading", { level: 1, name: room.name })).toBeVisible();
    await expect(focusTimer(owner).getByText("completed", { exact: true })).toBeVisible();
    await expect(
      focusTimer(owner).getByRole("button", { name: "Start 25 min session" }),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});
