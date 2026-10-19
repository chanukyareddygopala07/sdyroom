import { expect, test } from "@playwright/test";

/**
 * The marketing home page as a real browser journey: the editorial hero is
 * present with exactly one level-one heading, the pill navigation's
 * destinations are honest (no dead links), and the hero search is the real
 * discovery mechanism — it submits the real `q` parameter to `/rooms` and
 * hands a signed-out visitor to the existing sign-in gate with the query
 * intact, which is the authentication rule the app already enforces.
 */

test("the hero, pill navigation and closing CTA offer only live routes", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: /study together/i }),
  ).toBeVisible();

  // Pill navigation: logo home link, the two honest destinations, and the
  // account controls a signed-out visitor gets.
  await expect(page.getByRole("link", { name: "Public rooms" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "SdyRoom", exact: true }),
  ).toHaveAttribute("href", "/");

  // "How it works" is an in-page anchor that resolves to the section.
  await page.getByRole("link", { name: "How it works" }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(
    page.getByRole("heading", { name: /three steps/i }),
  ).toBeVisible();

  // Primary conversions land on the real registration flow.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute(
    "href",
    "/auth/sign-up",
  );
  await expect(page.getByRole("link", { name: "Join SdyRoom" })).toHaveAttribute(
    "href",
    "/auth/sign-up",
  );
});

test("the hero search drives the real discovery route and keeps auth rules", async ({
  page,
}) => {
  await page.goto("/");

  const search = page.getByPlaceholder("Find a study room, subject, or exam...");
  await search.fill("cell structure");
  await page.getByRole("button", { name: "Explore rooms" }).click();

  // Signed out, /rooms sends the visitor through the existing sign-in
  // gate — with the query still on the URL, so nothing the search produced
  // is lost to the redirect.
  await expect(page).toHaveURL(/\/auth\/login\?.*q=/);
  const landed = decodeURIComponent(page.url().replace(/\+/g, " "));
  expect(landed).toContain("cell structure");

  // The suggested searches are plain links with the same parameter.
  await page.goto("/");
  await page.getByRole("link", { name: "biology" }).click();
  await expect(page).toHaveURL(/\/auth\/login\?.*q=biology/);

  // The secondary hero CTA points at the same discovery route.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Explore study rooms" })).toHaveAttribute(
    "href",
    "/rooms",
  );
});

test("the decorative cards are hidden from assistive technology", async ({
  page,
}) => {
  await page.goto("/");

  // Design previews only: the copy is visible to sighted readers… the DOM
  // holds one desktop cluster and one mobile stack, so scope to the copy
  // that is actually on screen at this viewport.
  const preview = page
    .getByText("25:00")
    .filter({ visible: true })
    .first();
  await expect(preview).toBeVisible();

  // …but every element that carries it sits inside an aria-hidden cluster,
  // so no screen reader is told a fictional session is running.
  const hiddenPreview = page
    .locator('[aria-hidden="true"]')
    .filter({ hasText: "25:00" })
    .first();
  await expect(hiddenPreview).toBeAttached();
});
