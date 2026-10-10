import { expect, test } from "@playwright/test";
import {
  createRoomViaUi,
  joinRoomViaUi,
  roomCard,
  searchRooms,
} from "./helpers/rooms";
import { signUpAndOnboard, waitForHydration } from "./helpers/users";

/**
 * Room management end to end: the owner edits settings through the real
 * form, closes the room so it stops accepting joins, and deletes it after
 * the deliberate name-typed confirmation — while members keep their view of
 * the room but never reach the owner controls.
 */
test.describe("room management", () => {
  test("the owner edits settings members can see, and non-owners cannot reach them", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "set-owner");
      const room = await createRoomViaUi(owner, { label: "settings" });

      await signUpAndOnboard(member, "set-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);

      // The owner opens settings from the workspace header.
      await owner.goto(`/rooms/${room.id}`);
      await owner.getByRole("link", { name: "Room settings" }).click();
      await owner.waitForURL(/\/settings$/);
      await expect(owner.getByRole("heading", { level: 1, name: "Room settings" })).toBeVisible();

      const renamed = `${room.name} edited`;
      await waitForHydration(owner, "#settings-name");
      await owner.locator("#settings-name").fill(renamed);
      await owner.locator("#settings-shared_goal").fill("Ship the syllabus by Friday.");
      // Dirty state arms the button.
      const save = owner.getByRole("button", { name: "Save changes" });
      await expect(save).toBeEnabled();
      await save.click();
      // Filter by vocabulary: the header's notification live region is also
      // a role="status", exactly like chat's status-vs-headcount split.
      await expect(
        owner.getByRole("status").filter({ hasText: "Room settings saved." }),
      ).toHaveText("Room settings saved.");

      // The member sees the new name and goal after a refresh…
      await member.goto(`/rooms/${room.id}`);
      await expect(
        member.getByRole("heading", { level: 1, name: renamed }),
      ).toBeVisible();

      // …but never a path into the owner controls, on the page or in the URL.
      await expect(
        member.getByRole("link", { name: "Room settings" }),
      ).toHaveCount(0);
      await member.goto(`/rooms/${room.id}/settings`);
      await expect(
        member.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("closing a room from settings stops new joins and badges it as Closed", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const student = await studentContext.newPage();

    try {
      await signUpAndOnboard(owner, "close-owner");
      const room = await createRoomViaUi(owner, { label: "closeable" });

      await owner.goto(`/rooms/${room.id}/settings`);
      await waitForHydration(owner, "#settings-status");
      await owner.locator("#settings-status").selectOption("closed");
      await owner.getByRole("button", { name: "Save changes" }).click();
      await expect(
        owner.getByRole("status").filter({ hasText: "Room settings saved." }),
      ).toHaveText("Room settings saved.");

      // The owner's workspace badges the closed state.
      await owner.goto(`/rooms/${room.id}`);
      await expect(
        owner.getByText("Closed", { exact: true }).first(),
      ).toBeVisible();

      // A second student finds the room in discovery but cannot join it.
      await signUpAndOnboard(student, "close-student");
      await searchRooms(student, room.name);
      const card = roomCard(student, room.name);
      await expect(card.getByText("Room is closed.")).toBeVisible();
      await expect(card.getByText("Closed", { exact: true })).toBeVisible();
      await expect(
        card.getByRole("button", { name: `Join ${room.name}` }),
      ).toHaveCount(0);
    } finally {
      await ownerContext.close();
      await studentContext.close();
    }
  });

  test("deleting a room after typing its name removes it for everyone", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "del-owner");
      const room = await createRoomViaUi(owner, { label: "doomed" });

      await signUpAndOnboard(member, "del-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);

      await owner.goto(`/rooms/${room.id}/settings`);
      await waitForHydration(owner, "#delete-room-confirm");

      // The destructive button arms only for the exact room name.
      const confirm = owner.getByLabel(/to confirm/i);
      const deleteButton = owner.getByRole("button", {
        name: "Delete room permanently",
      });
      await expect(deleteButton).toBeDisabled();
      await confirm.fill("not the room name");
      await expect(deleteButton).toBeDisabled();
      await confirm.fill(room.name);
      await expect(deleteButton).toBeEnabled();

      await deleteButton.click();
      await owner.waitForURL(/\/rooms$/);

      // Gone from discovery for the owner…
      await searchRooms(owner, room.name);
      await expect(roomCard(owner, room.name)).toHaveCount(0);

      // …and the member's stale workspace URL is a 404 after a refresh.
      await member.goto(`/rooms/${room.id}`);
      await expect(
        member.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();

      await searchRooms(member, room.name);
      await expect(roomCard(member, room.name)).toHaveCount(0);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });
});
