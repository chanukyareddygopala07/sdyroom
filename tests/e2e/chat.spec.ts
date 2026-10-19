import { expect, test, type WebSocketRoute } from "@playwright/test";
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
 * Delivery is proven structurally: the chat panel never polls on a timer —
 * messages arrive from the `postgres_changes` INSERT on the WebSocket, or
 * from the single catch-up history read that runs on a join ack
 * (history reconciliation) — and with no page reload the rendering is
 * entirely client-side.
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

  test("a message sent while the viewer is offline appears after reconnect, without a reload", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    // Own the owner's realtime socket from the first dial: `setOffline`
    // alone only fires the browser's network events — an established
    // WebSocket survives it, which would let the message through live and
    // hide the defect this test exists to catch. Closing the route kills
    // the socket; flipping `realtimeUp` lets the next retry through, which
    // is the reconnect the fix has to recover from.
    let realtimeUp = true;
    let activeSocket!: WebSocketRoute | null;
    await owner.routeWebSocket(/realtime\/v1\/websocket/, (socket) => {
      if (!realtimeUp) {
        socket.close();
        return;
      }
      activeSocket = socket;
      socket.connectToServer();
    });

    try {
      await signUpAndOnboard(owner, "chat-offline-owner");
      const room = await createRoomViaUi(owner, {
        label: "chat-offline",
        capacity: 4,
      });
      await waitForLive(owner);

      await signUpAndOnboard(member, "chat-offline-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      await expect(chatStatus(owner)).toHaveText("Live", { timeout: 30_000 });
      await expect(chatStatus(member)).toHaveText("Live", { timeout: 30_000 });

      let fullLoads = 0;
      owner.on("load", () => {
        fullLoads += 1;
      });

      // Outage: drop the socket and take the context offline. The badge
      // admitting it is the precondition for the rest of the test — a
      // channel that stayed live would deliver the message anyway.
      realtimeUp = false;
      await activeSocket?.close();
      await ownerContext.setOffline(true);
      await expect(chatStatus(owner)).toHaveText("Reconnecting…", {
        timeout: 30_000,
      });

      // The member sends while the owner cannot receive. The row is
      // committed server-side — proven by the sender's own row leaving
      // "Sending…" — but no event will ever reach the closed socket.
      await chatPanel(member)
        .getByRole("textbox", { name: "Message" })
        .fill("Sent while you were offline");
      await chatPanel(member).getByRole("button", { name: "Send" }).click();
      const fromMember = chatPanel(member).locator("li", {
        hasText: "Sent while you were offline",
      });
      await expect(fromMember).toBeVisible();
      await expect(fromMember).not.toContainText("Sending…");
      await expect(fromMember).not.toContainText("Not sent.");

      // Heal: the client re-dials, the route forwards this time, and the
      // join ack's catch-up read is the only path that can bring the
      // missed message in — there is no chat poll, and no reload is
      // allowed to mask it (a reload would re-render history server-side).
      realtimeUp = true;
      await ownerContext.setOffline(false);
      await expect(
        chatPanel(owner).locator("li", {
          hasText: "Sent while you were offline",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(chatStatus(owner)).toHaveText("Live", { timeout: 30_000 });
      expect(fullLoads).toBe(0);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });
});
