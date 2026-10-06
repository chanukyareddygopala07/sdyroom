import { expect, test } from "@playwright/test";
import {
  chatPanel,
  chatStatus,
  createRoomViaUi,
  enterRoomViaUi,
  joinRoomViaUi,
  searchRooms,
  waitForLive,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * Room chat over the real local Supabase stack.
 *
 * Delivery is proven structurally: the chat panel has no poll of its own, so
 * a message appearing in the other browser can only have come from the
 * `postgres_changes` INSERT on the WebSocket — and with no page reload the
 * rendering is entirely client-side.
 */
test.describe("room chat in the browser", () => {
  test("two members exchange messages live, without a reload", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "chat-owner");
      const room = await createRoomViaUi(owner, { label: "chat", capacity: 4 });
      await waitForLive(owner);

      await signUpAndOnboard(member, "chat-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      // From here the workspace is settled: any `load` below would be a full
      // reload, not a setup navigation.
      let fullLoads = 0;
      owner.on("load", () => {
        fullLoads += 1;
      });
      member.on("load", () => {
        fullLoads += 1;
      });

      // Both chat channels report their own health, independently of the
      // focus timer's badge in the header area.
      await expect(chatStatus(owner)).toHaveText("Live", { timeout: 30_000 });
      await expect(chatStatus(member)).toHaveText("Live", { timeout: 30_000 });

      // The owner speaks first; the message lands in their own panel as
      // theirs, then is confirmed by the server.
      await chatPanel(owner).getByRole("textbox", { name: "Message" }).fill("Hello from owner");
      await chatPanel(owner).getByRole("button", { name: "Send" }).click();
      const ownLine = chatPanel(owner).locator("li", {
        hasText: "Hello from owner",
      });
      await expect(ownLine).toBeVisible();
      await expect(ownLine).toHaveAttribute("data-own", "true");

      // The member receives it live — no reload, and nothing in the chat
      // path polls, so the WebSocket is the only channel it can arrive on.
      const onMember = chatPanel(member).locator("li", {
        hasText: "Hello from owner",
      });
      await expect(onMember).toBeVisible({ timeout: 10_000 });
      await expect(onMember).not.toHaveAttribute("data-own", "true");

      // The reply travels the other way with the viewer-relative flag flipped.
      await chatPanel(member).getByRole("textbox", { name: "Message" }).fill("Hi back");
      await chatPanel(member).getByRole("button", { name: "Send" }).click();
      const ownReply = chatPanel(member).locator("li", { hasText: "Hi back" });
      await expect(ownReply).toBeVisible();
      await expect(ownReply).toHaveAttribute("data-own", "true");

      const onOwner = chatPanel(owner).locator("li", { hasText: "Hi back" });
      await expect(onOwner).toBeVisible({ timeout: 10_000 });
      await expect(onOwner).not.toHaveAttribute("data-own", "true");

      // Nothing ever reloaded: every update above was client-side.
      expect(fullLoads).toBe(0);
      await expect(chatStatus(owner)).toHaveText("Live");
      await expect(chatStatus(member)).toHaveText("Live");
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("an empty room invites the first message and seeds later visits", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();

    try {
      await signUpAndOnboard(owner, "chat-empty");
      const room = await createRoomViaUi(owner, {
        label: "chat-empty",
        capacity: 2,
      });
      await waitForLive(owner);

      // No history yet: the composer is ready and the status is honest about
      // the channel instead of claiming Live before the join is acknowledged.
      await expect(
        chatPanel(owner).getByText("No messages yet", { exact: false }),
      ).toBeVisible();
      await expect(chatStatus(owner)).toHaveText("Live", { timeout: 30_000 });

      await chatPanel(owner).getByRole("textbox", { name: "Message" }).fill("First words");
      await chatPanel(owner).getByRole("button", { name: "Send" }).click();
      const ownLine = chatPanel(owner).locator("li", { hasText: "First words" });
      await expect(ownLine).toBeVisible();

      // Reload only once the POST has been confirmed — until then the row
      // on screen is the optimistic one, which a reload would rightly lose.
      await expect(ownLine).not.toContainText("Sending…");
      await expect(ownLine).not.toContainText("Not sent.");

      // A fresh visit reads the same history from the server render.
      await owner.reload();
      await expect(
        chatPanel(owner).locator("li", { hasText: "First words" }),
      ).toBeVisible();
      await expect(chatStatus(owner)).toHaveText("Live", { timeout: 30_000 });
      expect(room.id).toBeTruthy();
    } finally {
      await ownerContext.close();
    }
  });
});
