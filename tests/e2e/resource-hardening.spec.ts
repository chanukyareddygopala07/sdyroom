import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { psql } from "../integration/helpers/admin";
import {
  fixtureBytes,
  resourceRow,
  submitUploadViaUi,
  uploadViaUi,
} from "./helpers/resources";
import { signUpAndOnboard, type E2EUser } from "./helpers/users";

/**
 * Resource hardening, driven through the real browser: the client-side size
 * and extension preflights, the quota line the library now reports, the
 * locked form once storage is full, and a spent upload window answered by the
 * server with `Retry-After`. The server-side equivalents (413/415 routing,
 * the 409 trigger, the sweep endpoint, the atomic rate-limit take) are
 * covered by the integration suite; this file proves a student meets them.
 */

const USER_LIMIT = 1_073_741_824; // 1 GiB
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROW_BYTES = 20_971_520; // study_resources_size check, upper bound
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uploadForm(page: Page) {
  return page.locator('form[aria-labelledby="personal-upload-heading"]');
}

function formAlert(page: Page) {
  return uploadForm(page).getByRole("alert");
}

/** Resolves the auth user id for a run-scoped e2e account. */
function userIdFor(user: E2EUser): string {
  if (!/^e2e\+[a-z0-9]+-?[a-z0-9-]*@example\.com$/.test(user.email)) {
    throw new Error(`Refusing to query a malformed e2e email: ${user.email}`);
  }
  const id = psql(`select id from auth.users where email = '${user.email}';`);
  if (!UUID_RE.test(id)) {
    throw new Error(`No single auth user for ${user.email}: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Brings the user's stored bytes to exactly the personal limit with legal
 * filler rows (no storage objects, which is fine: quotas are counted from
 * rows). The global teardown's cascade removes them with the account.
 */
function fillUserToLimit(userId: string): void {
  const rows: string[] = [];
  let remaining = USER_LIMIT;
  let seq = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, MAX_ROW_BYTES);
    const id = randomUUID();
    seq += 1;
    rows.push(
      `('${id}', '${userId}', null, 'personal/${userId}/${id}.pdf', ` +
        `'E2E FILLER ${seq}', 'filler.pdf', 'application/pdf', ${size}, null, null)`,
    );
    remaining -= size;
  }
  psql(
    "insert into public.study_resources " +
      "(id, owner_id, room_id, storage_path, title, original_filename, " +
      "content_type, size_bytes, subject, chapter) values " +
      `${rows.join(",")};`,
  );
}

function postUploadViaApi(
  page: Page,
  title: string,
): Promise<APIResponse> {
  return page.request.post("/api/resources", {
    multipart: {
      file: {
        name: "flood.pdf",
        mimeType: "application/pdf",
        buffer: fixtureBytes("rotational-motion.pdf"),
      },
      title,
    },
  });
}

test("refuses an oversized file before it leaves the browser", async ({ page }) => {
  await signUpAndOnboard(page, "hard-toobig");
  await page.goto("/resources");

  await submitUploadViaUi(
    page,
    { kind: "personal" },
    {
      name: "huge.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(MAX_FILE_BYTES + 1, 0x20),
    },
    "Scanner output",
  );

  await expect(formAlert(page)).toContainText("Files must be 20 MiB or smaller.");
  await expect(page.getByText(/No files yet/)).toBeVisible();

  const listing = await page.request.get("/api/resources?scope=personal");
  expect(listing.status()).toBe(200);
  expect((await listing.json()).resources).toHaveLength(0);
});

test("refuses an extension outside the closed list before it leaves the browser", async ({
  page,
}) => {
  await signUpAndOnboard(page, "hard-exe");
  await page.goto("/resources");

  await submitUploadViaUi(
    page,
    { kind: "personal" },
    { name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
    "Installer",
  );

  await expect(formAlert(page)).toContainText(
    "Only PDF, PNG, JPEG, TXT and Markdown files can be uploaded.",
  );

  const listing = await page.request.get("/api/resources?scope=personal");
  expect(listing.status()).toBe(200);
  expect((await listing.json()).resources).toHaveLength(0);
});

test("a normal upload still lands and the quota line tracks it", async ({ page }) => {
  await signUpAndOnboard(page, "hard-normal");
  await page.goto("/resources");
  await expect(page.getByText("0 B of 1 GiB used")).toBeVisible();

  const title = "Hardening regression upload";
  await uploadViaUi(
    page,
    { kind: "personal" },
    { name: "rotational-motion.pdf", buffer: fixtureBytes("rotational-motion.pdf") },
    title,
    { subject: "Physics", chapter: "Rotational motion" },
  );
  await expect(resourceRow(page, title)).toContainText("Physics");

  // 550 bytes, exactly the checked-in fixture: the number came back from the
  // quota query that rides the listing after `router.refresh()`.
  await expect(page.getByText("550 B of 1 GiB used")).toBeVisible();
});

test("a full library locks the form and the API refuses the next byte", async ({
  page,
}) => {
  const user = await signUpAndOnboard(page, "hard-full");
  const userId = userIdFor(user);
  fillUserToLimit(userId);

  await page.goto("/resources");
  await expect(page.getByText("1 GiB of 1 GiB used")).toBeVisible();
  await expect(
    page.getByText("Storage full — delete files to make room for new uploads."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();

  // The locked button is only the friendly layer: the server says no too,
  // and refuses before any object is written.
  const refused = await postUploadViaApi(page, "Blocked by quota");
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("quota_exceeded");

  const objects = psql(
    `select count(*) from storage.objects where owner = '${userId}';`,
  );
  expect(objects).toBe("0");
});

test("a spent upload window answers 429 with Retry-After, in the API and the form", async ({
  page,
}) => {
  await signUpAndOnboard(page, "hard-flood");
  await page.goto("/resources");

  // Ten uploads fill this library's per-target window (10 per 60 seconds)
  // over the real HTTP path — the same route and code the form uses.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const accepted = await postUploadViaApi(page, `Flood ${attempt}`);
    expect(accepted.status()).toBe(201);
  }

  const limited = await postUploadViaApi(page, "One too many");
  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBe("60");
  expect((await limited.json()).error.code).toBe("rate_limited");

  // …and the student sees the server's message in the form itself.
  await submitUploadViaUi(
    page,
    { kind: "personal" },
    { name: "rotational-motion.pdf", buffer: fixtureBytes("rotational-motion.pdf") },
    "One too many via the form",
  );
  await expect(formAlert(page)).toContainText(
    "Too many uploads — wait about a minute and try again.",
  );

  const listing = await page.request.get("/api/resources?scope=personal");
  expect(listing.status()).toBe(200);
  expect((await listing.json()).resources).toHaveLength(10);
});
