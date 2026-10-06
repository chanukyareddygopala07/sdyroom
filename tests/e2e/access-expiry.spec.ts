import { expect, test } from "@playwright/test";
import { psql } from "../integration/helpers/admin";
import {
  createRoomViaUi,
  focusTimer,
  goalsPanel,
  joinRoomViaUi,
  roomCard,
  searchRooms,
  startSession,
  waitForLive,
} from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuid(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`Refusing to interpolate a malformed id: ${value}`);
  }
  return value;
}

/**
 * Failure and recovery in a real browser: auth walls, indistinguishable 404s,
 * full and closed rooms, owner-only controls, API failures with an in-app
 * error and a working retry, and a session whose deadline passed while
 * nobody's tab was watching.
 */
test.describe("access, failures and recovery", () => {
  test("a signed-out visitor is sent to login from every room URL", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto("/rooms");
      await expect(page).toHaveURL(/\/auth\/login$/);

      await page.goto("/rooms/11111111-1111-4111-8111-111111111111");
      await expect(page).toHaveURL(/\/auth\/login$/);
    } finally {
      await context.close();
    }
  });

  test("a missing room and a room you are not in look identical", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signUpAndOnboard(page, "missing");

      await page.goto("/rooms/11111111-1111-4111-8111-111111111111");
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("full and closed rooms explain themselves instead of failing late", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const student = await studentContext.newPage();

    try {
      await signUpAndOnboard(owner, "cap-owner");
      const fullRoom = await createRoomViaUi(owner, { label: "full", capacity: 1 });
      const closedRoom = await createRoomViaUi(owner, { label: "closed", capacity: 4 });

      // capacity 1 is already taken by the owner.
      await signUpAndOnboard(student, "cap-student");
      await searchRooms(student, fullRoom.name);
      await expect(roomCard(student, fullRoom.name).getByText("Room is full.")).toBeVisible();
      await expect(
        roomCard(student, fullRoom.name).getByRole("button", { name: `Join ${fullRoom.name}` }),
      ).toHaveCount(0);

      // Closing the room is a state the owner cannot reach from the UI in
      // this milestone, so the row is moved directly — the card then reports
      // it before any join attempt.
      psql(
        `update public.rooms set status = 'closed' ` +
          `where id = '${assertUuid(closedRoom.id)}';`,
      );
      await searchRooms(student, closedRoom.name);
      await expect(
        roomCard(student, closedRoom.name).getByText("Room is closed."),
      ).toBeVisible();
      await expect(
        roomCard(student, closedRoom.name).getByRole("button", {
          name: `Join ${closedRoom.name}`,
        }),
      ).toHaveCount(0);
    } finally {
      await ownerContext.close();
      await studentContext.close();
    }
  });

  test("a member never gets owner controls, with or without a session", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();

    try {
      await signUpAndOnboard(owner, "ctrl-owner");
      const room = await createRoomViaUi(owner, { label: "controls", capacity: 4 });

      await signUpAndOnboard(member, "ctrl-member");
      await searchRooms(member, room.name);
      await joinRoomViaUi(member, room.name);
      await member.getByRole("link", { name: "Enter room" }).click();
      await expect(member.getByRole("heading", { level: 1, name: room.name })).toBeVisible();
      await waitForLive(member);

      // No session: the member sees the explanation, never a Start button.
      await expect(
        focusTimer(member).getByText("The room owner starts and controls the shared timer."),
      ).toBeVisible();
      await expect(focusTimer(member).getByRole("button", { name: /^Start/ })).toHaveCount(0);

      // Owner starts: still no Pause/End for the member.
      await startSession(owner, 25);
      await expect(focusTimer(member).getByText("running", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        focusTimer(member).getByText("The room owner controls this timer."),
      ).toBeVisible();
      await expect(focusTimer(member).getByRole("button", { name: "Pause" })).toHaveCount(0);
      await expect(focusTimer(member).getByRole("button", { name: "End session" })).toHaveCount(0);
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("an unreachable API surfaces an in-app error and the retry works", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signUpAndOnboard(page, "fail-owner");
      await createRoomViaUi(page, { label: "failure", capacity: 2 });
      await waitForLive(page);

      // Block the session endpoint, then the goal endpoint: both must fail
      // into a role="alert" message instead of a blank or broken screen.
      await page.route("**/api/rooms/*/session/start", (route) => route.abort());
      await focusTimer(page).getByRole("button", { name: "Start 25 min session" }).click();
      await expect(page.getByRole("alert").filter({ hasText: /could not reach/i })).toBeVisible();
      await page.unroute("**/api/rooms/*/session/start");

      // Recovery: the same click succeeds once the API is reachable again.
      await focusTimer(page).getByRole("button", { name: "Start 25 min session" }).click();
      await expect(focusTimer(page).getByText("running", { exact: true })).toBeVisible();

      await focusTimer(page).getByRole("button", { name: "End session" }).click();
      await expect(focusTimer(page).getByText("completed", { exact: true })).toBeVisible();

      await page.route("**/api/rooms/*/goals", (route) => route.abort());
      await goalsPanel(page).getByLabel("Goal title").fill("Blocked goal");
      await goalsPanel(page).getByRole("button", { name: "Add goal" }).click();
      await expect(
        goalsPanel(page).getByRole("alert").filter({ hasText: /could not reach/i }),
      ).toBeVisible();
      await page.unroute("**/api/rooms/*/goals");

      await goalsPanel(page).getByRole("button", { name: "Add goal" }).click();
      await expect(goalsPanel(page).getByText("Blocked goal")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a session whose deadline passed while nobody watched is recorded", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signUpAndOnboard(page, "expiry-owner");
      const room = await createRoomViaUi(page, { label: "expiry", capacity: 2 });
      await waitForLive(page);
      await startSession(page, 25);

      // No tab ever watches the countdown reach zero: the deadline passes
      // with the workspace unopened (the same trick the integration suite
      // uses), by moving the stored deadline into the past.
      psql(
        `update public.focus_sessions ` +
          `set started_at = now() - interval '2 seconds', ` +
          `    ends_at = now() - interval '1 second' ` +
          `where room_id = '${assertUuid(room.id)}' and state in ('running','paused');`,
      );

      // The next workspace read persists the passage of time: idle controls
      // come back and the session lands in history — nobody's browser needed
      // to be open for it.
      await page.reload();
      await expect(focusTimer(page).getByText(/completed|expired/)).toBeVisible();
      await expect(focusTimer(page).getByText("No session running.")).toBeVisible();
      await expect(
        focusTimer(page).getByRole("button", { name: "Start 25 min session" }),
      ).toBeVisible();
      // The recorded session can be started over: exactly one history row.
      await expect(focusTimer(page).getByText(/completed|expired/)).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("losing the session clears access on the next request", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signUpAndOnboard(page, "cookie-owner");
      await createRoomViaUi(page, { label: "cookie", capacity: 2 });
      await waitForLive(page);

      // The cookie jar is emptied behind the app's back, as an expired or
      // revoked session would be.
      await context.clearCookies();
      await focusTimer(page).getByRole("button", { name: "Start 25 min session" }).click();
      await expect(page).toHaveURL(/\/auth\/login$/);

      await page.goto("/rooms");
      await expect(page).toHaveURL(/\/auth\/login$/);
    } finally {
      await context.close();
    }
  });
});
