import { expect, test } from "@playwright/test";
import {
  fixtureBytes,
  libraryHeading,
  resourceRow,
  submitUploadViaUi,
  uploadViaUi,
} from "./helpers/resources";
import {
  createRoomViaUi,
  enterRoomViaUi,
  joinRoomViaUi,
  leaveRoomViaUi,
  searchRooms,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * The milestone's definition of done, driven through the real interface: a
 * student uploads a file, keeps it private, shares it with a room, and loses
 * that access when membership goes away. Every assertion is made on screen or
 * through the API with the session cookie the page actually holds.
 */

test("a private upload stays in the uploader's library", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await signUpAndOnboard(alice, "files-alice");
    await alice.goto("/resources");
    await expect(libraryHeading(alice, 1, "My resources")).toBeVisible();

    const title = "Rotational motion — private notes";
    await uploadViaUi(
      alice,
      { kind: "personal" },
      { name: "rotational-motion.pdf", buffer: fixtureBytes("rotational-motion.pdf") },
      title,
      { subject: "Physics", chapter: "Rotational motion" },
    );
    await expect(alice.getByText(/^Uploaded/)).toBeVisible();
    await expect(resourceRow(alice, title)).toContainText("Physics");

    // A second student's library is empty, both on screen and through the API.
    await signUpAndOnboard(bob, "files-bob");
    await bob.goto("/resources");
    await expect(bob.getByText(/No files yet/)).toBeVisible();
    await expect(resourceRow(bob, title)).toHaveCount(0);

    const listing = await bob.request.get("/api/resources?scope=personal");
    expect(listing.status()).toBe(200);
    expect((await listing.json()).resources).toHaveLength(0);

    // …and the file cannot be opened by guessing the id.
    const ownListing = await alice.request.get("/api/resources?scope=personal");
    const resources = (await ownListing.json()).resources as { id: string }[];
    expect(resources).toHaveLength(1);
    const denied = await bob.request.get(
      `/api/resources/${resources[0].id}/download`,
    );
    expect(denied.status()).toBe(404);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("rejects a file whose bytes do not match its name", async ({ page }) => {
  await signUpAndOnboard(page, "files-impostor");
  await page.goto("/resources");

  await submitUploadViaUi(
    page,
    { kind: "personal" },
    { name: "not-a-pdf.pdf", buffer: fixtureBytes("not-a-pdf.pdf") },
    "Impostor",
  );

  // Scoped to the upload form: Next's route announcer is also a role="alert".
  const uploadError = page
    .locator('form[aria-labelledby="personal-upload-heading"]')
    .getByRole("alert");
  await expect(uploadError).toContainText(
    "That file does not look like a valid document or image.",
  );
  await expect(page.getByText(/No files yet/)).toBeVisible();

  const listing = await page.request.get("/api/resources?scope=personal");
  expect((await listing.json()).resources).toHaveLength(0);
});

test("deleting a file asks for confirmation and then clears it", async ({ page }) => {
  await signUpAndOnboard(page, "files-delete");
  await page.goto("/resources");

  const title = "Disposable draft";
  await uploadViaUi(
    page,
    { kind: "personal" },
    { name: "rotational-motion.pdf", buffer: fixtureBytes("rotational-motion.pdf") },
    title,
  );

  await page.getByRole("button", { name: `Delete ${title}` }).click();
  // The row survives the first click: only the explicit confirmation deletes.
  await expect(
    page.getByRole("button", { name: `Confirm deleting ${title}` }),
  ).toBeVisible();
  await expect(resourceRow(page, title)).toBeVisible();

  await page.getByRole("button", { name: `Confirm deleting ${title}` }).click();
  await expect(resourceRow(page, title)).toHaveCount(0);
  await expect(page.getByText(/^Deleted/)).toBeVisible();
  await expect(page.getByText(/No files yet/)).toBeVisible();

  const listing = await page.request.get("/api/resources?scope=personal");
  expect((await listing.json()).resources).toHaveLength(0);
});

test("sends a signed-out visitor to the login screen", async ({ page }) => {
  await page.goto("/resources");
  await page.waitForURL(/\/auth\/login$/);
  await expect(page).toHaveURL(/\/auth\/login$/);
});

test("a shared file is readable by members and gone after they leave", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    await signUpAndOnboard(owner, "share-owner");
    const room = await createRoomViaUi(owner, {
      label: "Files",
      capacity: 4,
      visibility: "public",
    });

    const title = "Shared problem set";
    await uploadViaUi(
      owner,
      { kind: "room", roomId: room.id },
      { name: "rotational-motion.pdf", buffer: fixtureBytes("rotational-motion.pdf") },
      title,
      { subject: "Physics", chapter: "Rotational motion" },
    );
    await expect(resourceRow(owner, title)).toBeVisible();

    // A second student joins through discovery and sees it in the workspace.
    await signUpAndOnboard(member, "share-member");
    await searchRooms(member, room.name);
    await joinRoomViaUi(member, room.name);
    await enterRoomViaUi(member, room.name);
    await expect(libraryHeading(member, 2, "Resources")).toBeVisible();
    await expect(resourceRow(member, title)).toBeVisible();

    // Opening it opens a window onto a signed URL — never a permanent link.
    const popupPromise = member.waitForEvent("popup");
    await member.getByRole("button", { name: `Open ${title}` }).click();
    const popup = await popupPromise;
    await popup.close();

    const listing = await member.request.get(`/api/resources?room_id=${room.id}`);
    expect(listing.status()).toBe(200);
    const resources = (await listing.json()).resources as { id: string }[];
    expect(resources).toHaveLength(1);
    const resourceId = resources[0].id;

    const before = await member.request.get(
      `/api/resources/${resourceId}/download`,
    );
    expect(before.status()).toBe(200);
    expect((await before.json()).expires_in).toBe(300);

    // Leaving the room revokes access: the download is refused by RLS, and the
    // workspace itself 404s exactly like a room that never existed.
    await member.goto("/rooms");
    await leaveRoomViaUi(member, room.name);

    const after = await member.request.get(
      `/api/resources/${resourceId}/download`,
    );
    expect(after.status()).toBe(404);

    await member.goto(`/rooms/${room.id}`);
    await expect(member.getByRole("heading", { name: "Page not found" })).toBeVisible();

    // The uploader keeps their own file — membership was never theirs to lose.
    await owner.reload();
    await expect(resourceRow(owner, title)).toBeVisible();
    const stillThere = await owner.request.get(
      `/api/resources/${resourceId}/download`,
    );
    expect(stillThere.status()).toBe(200);
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});
