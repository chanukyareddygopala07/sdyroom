import { expect, test } from "@playwright/test";
import {
  createRoomViaUi,
  focusTimer,
  searchRooms,
  roomCard,
  startSession,
  waitForLive,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * A private room is unlisted for everyone: the owner creates it, is taken
 * straight into it and can run a session; nobody else can discover it, open
 * its workspace URL, or learn it exists.
 */
test("private room: the owner enters it, non-members are refused", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const outsider = await outsiderContext.newPage();

  try {
    await signUpAndOnboard(owner, "priv-owner");
    const room = await createRoomViaUi(owner, {
      label: "private",
      capacity: 2,
      visibility: "private",
    });
    await waitForLive(owner);
    await expect(
      focusTimer(owner).getByRole("button", { name: "Start 25 min session" }),
    ).toBeVisible();

    await signUpAndOnboard(outsider, "priv-outsider");

    // Discovery never lists it — neither the full list nor a name search.
    // Other tests' public rooms may share this database, so wait until the
    // results have actually rendered (cards, or the empty-world message)
    // and then assert only that *this* room is absent, not that the list is.
    await expect(
      outsider
        .getByRole("article")
        .first()
        .or(outsider.getByText("No public rooms yet. Create the first one.")),
    ).toBeVisible();
    await expect(roomCard(outsider, room.name)).toHaveCount(0);
    await searchRooms(outsider, room.name);
    await expect(outsider.getByText("No public rooms match your search.")).toBeVisible();
    await expect(roomCard(outsider, room.name)).toHaveCount(0);

    // Knowing the URL is not enough: the workspace 404s like a missing room.
    await outsider.goto(`/rooms/${room.id}`);
    await expect(outsider.getByRole("heading", { name: "Page not found" })).toBeVisible();

    // The owner is unaffected and can focus in the room they created.
    await owner.reload();
    await expect(owner.getByRole("heading", { level: 1, name: room.name })).toBeVisible();
    await startSession(owner, 25);
    await expect(focusTimer(owner).getByText("running", { exact: true })).toBeVisible();
    await expect(
      focusTimer(owner).getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await outsiderContext.close();
  }
});
