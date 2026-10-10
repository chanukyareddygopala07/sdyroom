import { expect, test, type Page } from "@playwright/test";
import { createRoomViaUi, focusTimer } from "./helpers/rooms";
import { signUpAndOnboard } from "./helpers/users";

/**
 * The responsive shell and the accessibility work it carries: one navigation
 * mechanism per breakpoint (inline links from `md:`, the labelled disclosure
 * below it), no horizontal overflow on a phone, a keyboard-operable sheet
 * that returns focus where it started, the skip link landing on `#main`,
 * and the focus timer's countdown kept out of the live regions.
 */

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 720 };

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `expected no horizontal overflow (scrollWidth=${widths.scrollWidth}, clientWidth=${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth + 1);
}

test.describe("mobile navigation", () => {
  test.use({ viewport: PHONE });

  test("the disclosure is the only navigation control and routes through the sheet", async ({
    page,
  }) => {
    const user = await signUpAndOnboard(page, "resp-nav");
    await expect(page).toHaveURL(/\/rooms$/);

    // Below md: the inline header links are gone from the accessibility
    // tree; the labelled disclosure is the way in.
    await expect(page.getByRole("link", { name: "Public rooms" })).toHaveCount(
      0,
    );
    const trigger = page.getByRole("button", {
      name: "Open navigation menu",
    });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Navigation menu" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Public rooms" })).toBeVisible();
    await expect(
      sheet.getByRole("link", { name: "My resources" }),
    ).toBeVisible();
    // The session's own alias is offered as an account control.
    await expect(sheet.getByText(`Hey, ${user.alias}!`)).toBeVisible();

    await sheet.getByRole("link", { name: "Public rooms" }).click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("the sheet is keyboard-operable and returns focus to the trigger", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "resp-kbd");
    const trigger = page.getByRole("button", {
      name: "Open navigation menu",
    });

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Navigation menu" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("desktop navigation", () => {
  test.use({ viewport: DESKTOP });

  test("shows the inline links and hides the disclosure", async ({ page }) => {
    await signUpAndOnboard(page, "resp-desk");
    await expect(page).toHaveURL(/\/rooms$/);

    await expect(page.getByRole("link", { name: "Public rooms" })).toBeVisible();
    await expect(page.getByRole("link", { name: "My resources" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Invitations" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open navigation menu" }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("phone layouts", () => {
  test.use({ viewport: PHONE });

  test("public and auth pages fit the viewport", async ({ page }) => {
    for (const path of ["/", "/auth/login", "/auth/sign-up"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }

    await expect(page.getByLabel("Email")).toBeVisible();
    // exact: the sign-up form also has a "Repeat Password" field.
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });

  test("signed-in pages, the workspace and the resource library fit the viewport", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "resp-fit");
    for (const path of ["/rooms", "/rooms/new", "/resources", "/invitations"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }

    const room = await createRoomViaUi(page, { label: "resp-fit" });
    await expectNoHorizontalOverflow(page);

    await page.goto(`/rooms/${room.id}/settings`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Room settings" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the skip link is the first tab stop and lands on the main landmark", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "resp-skip");
    // Fresh load: after a client-side navigation the shell has already moved
    // focus to #main, so Tab would start from there instead of the top.
    await page.goto("/rooms");
    await expect(page).toHaveURL(/\/rooms$/);

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();

    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("main");
  });

  test("the focus timer keeps its ticking countdown out of the live regions", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "resp-timer");
    // Creating through the UI lands us inside the new workspace.
    await createRoomViaUi(page, { label: "resp-timer" });

    const timer = focusTimer(page);
    await expect(timer).toBeVisible();
    // The sync badge is the section's only role="status"; the countdown
    // beside it must not be a live region, or it would announce every tick.
    await expect(timer.getByRole("status")).toHaveCount(1);
    const countdown = timer.locator("p.font-mono");
    await expect(countdown).toBeVisible();
    await expect(countdown).not.toHaveAttribute("aria-live", /.*/);
    await expect(timer.locator("[aria-live]")).toHaveCount(1);
    await expect(timer.locator("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    await expectNoHorizontalOverflow(page);
  });
});
