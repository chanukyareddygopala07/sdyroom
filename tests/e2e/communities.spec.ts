import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signUpAndOnboard, waitForHydration } from "./helpers/users";

const WAITING_BANNER =
  "Waiting for a community member to set up encryption for this channel";
const UNDECRYPTABLE = "This message can't be decrypted on this device yet.";

function messages(page: Page) {
  return page.getByRole("list", { name: "Messages" });
}

function chip(page: Page, text: string) {
  return page.getByText(text, { exact: true });
}

/**
 * The encrypted community journey in two real browsers: the owner creates an
 * open community (their client bootstraps the MLS channel group), a second
 * student joins and is honestly locked out until the owner's next sync Adds
 * their device and addresses the welcome, pre-join history stays opaque
 * forever (forward secrecy) but says so, and once the welcome lands both
 * sides exchange encrypted messages with no reload — realtime delivery and
 * client-side decryption of the other browser's ciphertext.
 */
test("communities: two browsers open one encrypted channel and exchange messages", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  try {
    const tag = Date.now().toString(36);
    const name = `Cipher Room ${tag}`;
    const slug = `cipher-room-${tag}`;

    // Owner creates the community through the real dialog and lands inside.
    await signUpAndOnboard(owner, "cm-owner");
    await owner.goto("/communities");
    await waitForHydration(owner, "#community-search");
    await owner.getByRole("button", { name: "New community" }).click();
    await waitForHydration(owner, "#community-create-name");
    await owner.locator("#community-create-name").fill(name);
    await owner.locator("#community-create-slug").fill(slug);
    await owner.getByRole("button", { name: "Create community" }).click();
    await owner.waitForURL(/\/communities\/[0-9a-f-]{36}$/);
    await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();

    // Bootstrap: the owner's client creates the channel group and the chip
    // settles on Encrypted with an enabled composer.
    await expect(chip(owner, "Encrypted")).toBeVisible({ timeout: 30_000 });
    const ownerComposer = owner.getByRole("textbox", { name: "Message" });
    await expect(ownerComposer).toBeEnabled();
    await ownerComposer.fill("hello before the join");
    await owner.getByRole("button", { name: "Send" }).click();
    await expect(messages(owner).getByText("hello before the join")).toBeVisible();

    // Second browser: discovery, then join.
    await signUpAndOnboard(member, "cm-member");
    await member.goto("/communities");
    await waitForHydration(member, "#community-search");
    await member.locator("#community-search").fill(name);
    await member.getByRole("button", { name: "Search", exact: true }).click();
    await member.getByRole("link", { name, exact: true }).click();
    await member.waitForURL(/\/communities\/[0-9a-f-]{36}$/);
    await waitForHydration(member, "h1");
    await member.getByRole("button", { name: "Join community" }).click();

    // First face of the workspace: nobody has Added this device yet, so the
    // channel waits, the composer stays locked, and the pre-join message is
    // named as undecryptable rather than hidden.
    await expect(member.getByText(WAITING_BANNER)).toBeVisible({ timeout: 30_000 });
    await expect(chip(member, "Can't decrypt")).toBeVisible();
    const memberComposer = member.getByRole("textbox", { name: "Message" });
    await expect(memberComposer).toBeDisabled();
    await expect(messages(member).getByText(UNDECRYPTABLE)).toBeVisible();

    // The owner's next sync Adds the joiner's device: commit + welcome go out.
    await owner.reload();
    await expect(chip(owner, "Encrypted")).toBeVisible({ timeout: 30_000 });

    // The joiner's reload consumes the welcome, joins the group, and unlocks
    // the composer — while pre-join history stays opaque and says so.
    await member.reload();
    await expect(member.getByText(WAITING_BANNER)).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(chip(member, "Encrypted")).toBeVisible();
    await expect(member.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(messages(member).getByText(UNDECRYPTABLE)).toBeVisible();

    // The member sends into the group…
    await member.getByRole("textbox", { name: "Message" }).fill(
      "hi from the member",
    );
    await member.getByRole("button", { name: "Send" }).click();
    await expect(messages(member).getByText("hi from the member")).toBeVisible();

    // …and the owner decrypts it live, without reloading.
    await expect(messages(owner).getByText("hi from the member")).toBeVisible({
      timeout: 30_000,
    });

    // The reply crosses back the same way.
    await owner.getByRole("textbox", { name: "Message" }).fill("welcome aboard");
    await owner.getByRole("button", { name: "Send" }).click();
    await expect(messages(owner).getByText("welcome aboard")).toBeVisible();
    await expect(messages(member).getByText("welcome aboard")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});

