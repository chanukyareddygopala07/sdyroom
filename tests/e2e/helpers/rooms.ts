import { expect, type Page } from "@playwright/test";
import { waitForHydration } from "./users";

let sequence = 0;

/** Unique room name so search and list assertions never match leftovers. */
export function uniqueRoomName(label: string): string {
  sequence += 1;
  return `E2E ${process.env.E2E_RUN_ID ?? "run"}-${process.pid}-${sequence} ${label}`;
}

export type CreatedRoom = { id: string; name: string };

/**
 * Creates a room through the real form. On 201 the app navigates straight
 * into the new workspace, so this returns once the workspace is on screen.
 */
export async function createRoomViaUi(
  page: Page,
  opts: { label: string; capacity?: number; visibility?: "public" | "private" },
): Promise<CreatedRoom> {
  const name = uniqueRoomName(opts.label);
  await page.goto("/rooms/new");
  // Controlled inputs: fill only once React owns them (see waitForHydration).
  await waitForHydration(page, "#name");
  await page.locator("#name").fill(name);
  await page.locator("#capacity").fill(String(opts.capacity ?? 4));
  if (opts.visibility) {
    await page.locator("#visibility").selectOption(opts.visibility);
  }
  await page.getByRole("button", { name: /create room/i }).click();
  await page.waitForURL(/\/rooms\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").pop();
  if (!id) {
    throw new Error(`Could not read a room id from ${page.url()}`);
  }
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return { id, name };
}

/** The discovery card for one room (the `article` around its heading). */
export function roomCard(page: Page, roomName: string) {
  return page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: roomName, exact: true }) });
}

/** Searches discovery for an exact room name (discovery lists public rooms). */
export async function searchRooms(page: Page, query: string): Promise<void> {
  await page.goto("/rooms");
  // Controlled input: fill only once React owns it (see waitForHydration).
  await waitForHydration(page, "#room-search");
  await page.locator("#room-search").fill(query);
  await page.getByRole("button", { name: "Search", exact: true }).click();
}

export async function joinRoomViaUi(page: Page, roomName: string): Promise<void> {
  await roomCard(page, roomName)
    .getByRole("button", { name: `Join ${roomName}` })
    .click();
  await expect(
    roomCard(page, roomName).getByRole("link", { name: "Enter room" }),
  ).toBeVisible();
}

export async function leaveRoomViaUi(page: Page, roomName: string): Promise<void> {
  await roomCard(page, roomName)
    .getByRole("button", { name: `Leave ${roomName}` })
    .click();
  await expect(
    roomCard(page, roomName).getByRole("link", { name: "Enter room" }),
  ).toHaveCount(0);
}

export async function enterRoomViaUi(page: Page, roomName: string): Promise<void> {
  await roomCard(page, roomName).getByRole("link", { name: "Enter room" }).click();
  await page.waitForURL(/\/rooms\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: roomName })).toBeVisible();
}

/* ------------------------- workspace locators ------------------------- */

export function focusTimer(page: Page) {
  return page.getByRole("region", { name: "Focus timer" });
}

export function goalsPanel(page: Page) {
  return page.getByRole("region", { name: "My goals in this room" });
}

export function chatPanel(page: Page) {
  return page.getByRole("region", { name: "Chat" });
}

/**
 * The chat connection badge only: Connecting… / Live / Reconnecting… /
 * Chat unavailable. The panel's header carries a second `role="status"` —
 * the presence headcount — so the vocabulary, not the role alone, picks the
 * one this helper means.
 */
export function chatStatus(page: Page) {
  return chatPanel(page)
    .getByRole("status")
    .filter({ hasText: /^(Connecting…|Live|Reconnecting…|Chat unavailable)$/ });
}

/**
 * The presence headcount: `<n> here`, or `<n> studying · <n> here` while a
 * session is running. Absent until the first presence sync has been observed.
 */
export function presenceCount(page: Page) {
  return chatPanel(page).getByRole("status").filter({ hasText: /here$/ });
}

/** The roster as rendered — each `<li>` one member (`alias · studying`). */
export function participantBadges(page: Page) {
  return chatPanel(page)
    .getByRole("list", { name: "Participants" })
    .getByRole("listitem");
}

/** The realtime subscription indicator: Connecting… / Live / Reconnecting…. */
export function syncStatus(page: Page) {
  return focusTimer(page).getByRole("status");
}

/** Waits for the member's channel to report `Live`. */
export async function waitForLive(page: Page): Promise<void> {
  await expect(syncStatus(page)).toHaveText("Live", { timeout: 30_000 });
}

/** Waits until the owner has actually started a session. */
export async function startSession(page: Page, minutes = 25): Promise<void> {
  await focusTimer(page)
    .getByRole("button", { name: `Start ${minutes} min session` })
    .click();
  await expect(focusTimer(page).getByText("running", { exact: true })).toBeVisible();
}

/** The big countdown inside the timer. */
export function clock(page: Page) {
  return focusTimer(page).getByText(/^\d{2}:\d{2}$/);
}
