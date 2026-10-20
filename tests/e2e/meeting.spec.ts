import { expect, test } from "@playwright/test";
import {
  createRoomViaUi,
  enterRoomViaUi,
  joinRoomViaUi,
  searchRooms,
  waitForLive,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * Live meetings in the browser, against the real local stack.
 *
 * The join flow is gated on `LIVEKIT_URL` (loaded into `process.env` by the
 * global setup, exactly as `next dev` sees it): without a configured provider
 * the workspace must be honestly unavailable — the Meeting control is
 * disabled and explained, and no Join button exists anywhere. With a provider
 * the suite joins a real LiveKit room through the production token route;
 * Chromium runs on fake media devices so the camera/microphone tracks are
 * real, local, and never touch hardware.
 */
const configured = Boolean(process.env.LIVEKIT_URL);

// Headless Chromium has no camera or microphone; the fake devices give the
// meeting real local tracks without touching hardware (only the configured
// test joins, but the flags are harmless for the other one).
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});

test.describe("live meetings in the browser", () => {
  test("the meeting view is honestly unavailable with no provider configured", async ({
    browser,
  }) => {
    test.skip(configured, "unconfigured path — the configured flow covers this machine");

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signUpAndOnboard(page, "meet-off");
      await createRoomViaUi(page, { label: "meetoff", capacity: 4 });
      await waitForLive(page);

      const meeting = page.getByRole("button", { name: "Meeting" });
      await expect(meeting).toBeDisabled();
      await expect(meeting).toHaveAttribute(
        "title",
        "Live meetings are not configured on this server yet.",
      );
      // Meeting mode is unreachable, so the join card cannot appear either.
      await expect(page.getByRole("button", { name: "Join meeting" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a member joins, meets, and leaves through the workspace toggle", async ({
    browser,
  }) => {
    test.skip(!configured, "requires LIVEKIT_URL (and keys) in the environment");

    const ownerContext = await browser.newContext({
      permissions: ["camera", "microphone"],
    });
    const memberContext = await browser.newContext({
      permissions: ["camera", "microphone"],
    });
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "meet-owner");
      const room = await createRoomViaUi(owner, { label: "meetlive", capacity: 4 });
      await waitForLive(owner);

      // Join card first — the camera never opens before this click.
      await owner.getByRole("button", { name: "Meeting" }).click();
      await expect(
        owner.getByRole("heading", { name: "Live meeting" }),
      ).toBeVisible();
      await owner.getByRole("button", { name: "Join meeting" }).click();

      // Connected: the controls LiveKit only shows in a call are all here.
      await expect(owner.getByRole("button", { name: "Leave meeting" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(owner.getByRole("button", { name: "Mute microphone" })).toBeVisible();
      await expect(owner.getByRole("button", { name: "Turn camera off" })).toBeVisible();
      await expect(owner.getByRole("button", { name: "Share screen" })).toBeVisible();
      await expect(owner.getByRole("status").filter({ hasText: /in the meeting/ })).toHaveText(
        "1 in the meeting",
      );

      // A second member joins the same study room and the same meeting.
      await signUpAndOnboard(member, "meet-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await enterRoomViaUi(member, room.name);
      await waitForLive(member);

      await member.getByRole("button", { name: "Meeting" }).click();
      await member.getByRole("button", { name: "Join meeting" }).click();
      await expect(member.getByRole("button", { name: "Leave meeting" })).toBeVisible({
        timeout: 30_000,
      });

      await expect(owner.getByRole("status").filter({ hasText: /in the meeting/ })).toHaveText(
        "2 in the meeting",
        { timeout: 20_000 },
      );

      // Leaving returns to the join card; the study workspace is one click
      // away and the chat stayed mounted the whole time.
      await owner.getByRole("button", { name: "Leave meeting" }).click();
      await expect(owner.getByRole("button", { name: "Join meeting" })).toBeVisible();
      await owner.getByRole("button", { name: "Study" }).click();
      await expect(owner.getByRole("button", { name: "Meeting" })).toBeVisible();
      await expect(owner.getByRole("button", { name: "Join meeting" })).toHaveCount(0);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });
});
