import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as downloadGet } from "@/app/api/resources/[id]/download/route";
import { POST as cleanupPost } from "@/app/api/resources/cleanup/route";
import { DELETE as resourceDelete } from "@/app/api/resources/[id]/route";
import { GET as resourcesGet, POST as resourcesPost } from "@/app/api/resources/route";
import { RESOURCE_BUCKET } from "@/lib/resources/types";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { MAX_FILE_BYTES } from "@/lib/validation/resources";
import { psql, psqlExpectingFailure } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_LIMIT = 1_073_741_824; // 1 GiB, mirrored from migration 0010
const ROOM_LIMIT = 524_288_000; // 500 MiB
const MAX_ROW_BYTES = 20_971_520; // study_resources_size check, upper bound

function pdfFile(name: string, text: string): File {
  const bytes = new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF\n`);
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

async function upload(
  fields: Record<string, string>,
  file: File = pdfFile("notes.pdf", "rotational motion"),
): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return callApi(resourcesPost, { path: "/api/resources", method: "POST", form });
}

function listResources(query: string): Promise<Response> {
  return callApi(resourcesGet, { path: `/api/resources${query}` });
}

function deleteOf(id: string): Promise<Response> {
  return callApiWithParams(
    resourceDelete,
    { path: `/api/resources/${id}`, method: "DELETE" },
    { id },
  );
}

function cleanupOf(body: Record<string, unknown> = {}): Promise<Response> {
  return callApi(cleanupPost, {
    path: "/api/resources/cleanup",
    method: "POST",
    body,
  });
}

/** Authoritative sums and counts, ignoring RLS — the assertions' oracle. */
function ownerSum(userId: string): number {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Refusing to query a malformed user id: ${userId}`);
  }
  return Number(
    psql(
      `select coalesce(sum(size_bytes), 0) from public.study_resources where owner_id = '${userId}';`,
    ),
  );
}

function roomSum(roomId: string): number {
  if (!UUID_RE.test(roomId)) {
    throw new Error(`Refusing to query a malformed room id: ${roomId}`);
  }
  return Number(
    psql(
      `select coalesce(sum(size_bytes), 0) from public.study_resources where room_id = '${roomId}';`,
    ),
  );
}

function rowCountFor(userId: string): number {
  return Number(
    psql(`select count(*) from public.study_resources where owner_id = '${userId}';`),
  );
}

function storageCount(userId: string): number {
  return Number(
    psql(`select count(*) from storage.objects where owner = '${userId}';`),
  );
}

function storageHas(userId: string, name: string): boolean {
  return (
    psql(
      `select count(*) from storage.objects where owner = '${userId}' and name = '${name}';`,
    ) === "1"
  );
}

/**
 * Brings the user's stored bytes to exactly `target` by inserting filler
 * rows. Each row satisfies every study_resources check and rides the quota
 * trigger, so the fillers themselves prove the trigger accepts legal rows.
 */
function fillUserTo(userId: string, target: number): void {
  let remaining = target - ownerSum(userId);
  if (remaining < 0) {
    throw new Error(
      `User ${userId} already stores ${target - remaining} bytes; cannot fill down to ${target}.`,
    );
  }
  const rows: string[] = [];
  let seq = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, MAX_ROW_BYTES);
    const id = randomUUID();
    seq += 1;
    rows.push(
      `('${id}', '${userId}', null, 'personal/${userId}/${id}.pdf', ` +
        `'FILLER ${seq}', 'filler.pdf', 'application/pdf', ${size}, null, null)`,
    );
    remaining -= size;
  }
  if (rows.length > 0) {
    psql(
      "insert into public.study_resources " +
        "(id, owner_id, room_id, storage_path, title, original_filename, " +
        "content_type, size_bytes, subject, chapter) values " +
        `${rows.join(",")};`,
    );
  }
}

/** An orphan row: no storage object ever lands under this key. */
function insertOrphanRow(ownerId: string, storagePath: string): void {
  psql(
    "insert into public.study_resources " +
      "(id, owner_id, room_id, storage_path, title, original_filename, " +
      "content_type, size_bytes, created_at, updated_at) values " +
      `('${randomUUID()}', '${ownerId}', ` +
      `${storagePath.startsWith("rooms/") ? `'${storagePath.split("/")[1]}'` : "null"}, ` +
      `'${storagePath}', 'Orphaned row', 'orphan.pdf', 'application/pdf', 11, ` +
      "now() - interval '10 minutes', now() - interval '10 minutes');",
  );
}

async function putObject(user: TestUser, name: string): Promise<void> {
  const { error } = await user.client.storage
    .from(RESOURCE_BUCKET)
    .upload(name, new TextEncoder().encode("%PDF-1.4\norphan\n"), {
      contentType: "application/pdf",
    });
  if (error) {
    throw new Error(`object upload failed for ${name}: ${error.message}`);
  }
}

function backdateObject(name: string): void {
  psql(
    `update storage.objects set created_at = now() - interval '10 minutes' ` +
      `where bucket_id = '${RESOURCE_BUCKET}' and name = '${name}';`,
  );
}

function rateRow(key: string): { count: number } | null {
  const output = psql(
    `select count from public.rate_limits where key = '${key}';`,
  );
  if (output === "") {
    return null;
  }
  return { count: Number(output) };
}

describe("upload abuse protection", () => {
  let alice: TestUser;
  let bob: TestUser;
  let chk: TestUser;
  let upl: TestUser;
  let cln: TestUser;
  let roomId: string;

  beforeAll(async () => {
    [alice, bob, chk, upl, cln] = await Promise.all([
      createUser("hard-alice"),
      createUser("hard-bob"),
      createUser("hard-chk"),
      createUser("hard-upl"),
      createUser("hard-cln"),
    ]);

    await Promise.all(
      [alice, bob].map((user, index) =>
        createProfile(user.client, user.id, uniqueAlias(`H${index}`)),
      ),
    );

    roomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("Hardening"), capacity: 4 }),
      )
    ).id;
    await joinRoom(bob.client, roomId);
  });

  afterAll(async () => {
    // Objects are removed while each owner is still signed in: the storage
    // DELETE policy is owner-only, and a session cannot outlive its user.
    for (const user of [alice, bob, chk, upl, cln]) {
      const output = psql(
        `select name from storage.objects where owner = '${user.id}';`,
      );
      const names = output === "" ? [] : output.split("\n");
      if (names.length > 0) {
        await user.client.storage.from(RESOURCE_BUCKET).remove(names);
      }
    }
    clearCookies();
    await deleteUsers([alice, bob, chk, upl, cln]);
  });

  describe("rate_limits table", () => {
    it("carries no grants for any API role", () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of ["select", "insert", "update", "delete"]) {
          expect(
            psql(
              `select has_table_privilege('${role}', 'public.rate_limits', '${privilege}');`,
            ),
            `${role} must not hold ${privilege} on rate_limits`,
          ).toBe("f");
        }
      }
    });

    it("enables RLS with zero policies — the second closed door", () => {
      expect(
        psql("select relrowsecurity from pg_class where oid = 'public.rate_limits'::regclass;"),
      ).toBe("t");
      expect(
        psql(
          "select count(*) from pg_policies where schemaname = 'public' and tablename = 'rate_limits';",
        ),
      ).toBe("0");
    });

    it("grants execute only on the functions the API calls", () => {
      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.rate_limit_take(text,integer,interval)', 'execute');",
        ),
      ).toBe("t");
      expect(
        psql(
          "select has_function_privilege('anon', 'public.rate_limit_take(text,integer,interval)', 'execute');",
        ),
      ).toBe("f");
      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.resource_quota(uuid)', 'execute');",
        ),
      ).toBe("t");
      expect(
        psql(
          "select has_function_privilege('authenticated', 'public.study_resources_quota_guard()', 'execute');",
        ),
      ).toBe("f");
    });

    it("refuses a live anon attempt to call the take function", () => {
      const result = psqlExpectingFailure(
        "set role anon; select public.rate_limit_take('anon-probe', 1, interval '1 minute');",
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("permission denied");
    });
  });

  describe("rate_limit_take", () => {
    it("allows up to the ceiling, then refuses, then restarts on rollover", async () => {
      const key = `probe:window:${cln.id}`;
      const take = () =>
        cln.client.rpc("rate_limit_take", {
          p_key: key,
          p_max: 2,
          p_window: "1 minute",
        });

      expect((await take()).data).toBe(true);
      expect((await take()).data).toBe(true);
      expect((await take()).data).toBe(false);

      expect(rateRow(key)?.count).toBe(3);

      // Backdate the window: the next take opens a fresh one at count 1.
      psql(
        `update public.rate_limits set window_start = now() - interval '2 minutes' where key = '${key}';`,
      );
      expect((await take()).data).toBe(true);
      expect(rateRow(key)?.count).toBe(1);
    });

    it("cannot be raced past its ceiling", async () => {
      const key = `probe:race:${cln.id}`;
      const take = () =>
        cln.client.rpc("rate_limit_take", {
          p_key: key,
          p_max: 2,
          p_window: "1 minute",
        });

      const results = await Promise.all(
        Array.from({ length: 6 }, () => take()),
      );
      const allowed = results.filter((result) => result.data === true);

      expect(allowed).toHaveLength(2);
      expect(rateRow(key)?.count).toBe(6);
    });

    it("rejects invalid parameters instead of storing nonsense", async () => {
      const result = await cln.client.rpc("rate_limit_take", {
        p_key: `probe:invalid:${cln.id}`,
        p_max: 0,
        p_window: "1 minute",
      });

      expect(result.error).not.toBeNull();
      expect(result.error?.code).toBe("22023");
    });

    it("proves both closed doors with a grant/revoke control", async () => {
      // Baseline: no grant, so direct access fails before RLS is even read.
      const denied = await upl.client.from("rate_limits").select("key");
      expect(denied.error?.code).toBe("42501");

      try {
        psql("grant select, insert on table public.rate_limits to authenticated;");

        // With grants restored, RLS is what remains: reads see nothing and
        // writes are refused outright — defence in depth, not one lone fence.
        const allowedSelect = await upl.client.from("rate_limits").select("key");
        expect(allowedSelect.error).toBeNull();
        expect(allowedSelect.data).toEqual([]);

        const allowedInsert = await upl.client
          .from("rate_limits")
          .insert({
            key: "control-probe",
            window_start: new Date().toISOString(),
            count: 1,
          });
        expect(allowedInsert.error).not.toBeNull();
        expect(allowedInsert.error?.message).toContain("row-level security");
      } finally {
        psql("revoke select, insert on table public.rate_limits from authenticated;");
      }

      const deniedAgain = await upl.client.from("rate_limits").select("key");
      expect(deniedAgain.error?.code).toBe("42501");
      expect(
        psql(
          "select has_table_privilege('authenticated', 'public.rate_limits', 'select');",
        ),
      ).toBe("f");
    });
  });

  describe("upload size and type guards", () => {
    it("refuses a file over the ceiling with 413 and writes nothing", async () => {
      await seedSession(chk.email, chk.password);
      const oversize = new File(
        [new Uint8Array(MAX_FILE_BYTES + 1) as BlobPart],
        "huge.pdf",
        { type: "application/pdf" },
      );

      const response = await upload({ title: "Too big" }, oversize);

      expect(response.status).toBe(413);
      expect(errorOf(await readJson(response)).code).toBe("file_too_large");
      expect(storageCount(chk.id)).toBe(0);
      expect(rowCountFor(chk.id)).toBe(0);
    });

    it("refuses an extension outside the closed list with 415 and writes nothing", async () => {
      await seedSession(chk.email, chk.password);

      const response = await upload(
        { title: "Installer" },
        new File(["MZ"], "setup.exe", { type: "application/octet-stream" }),
      );

      expect(response.status).toBe(415);
      expect(errorOf(await readJson(response)).code).toBe("unsupported_file_type");
      expect(storageCount(chk.id)).toBe(0);
      expect(rowCountFor(chk.id)).toBe(0);
    });

    it("refuses an oversized put at the storage layer, independent of the app", async () => {
      // The bucket's own file_size_limit is the belt to the app's braces:
      // a client that skips /api/resources entirely still cannot land 21 MiB.
      const bytes = new Uint8Array(MAX_FILE_BYTES + 1);
      bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
      const key = `personal/${chk.id}/bypass.pdf`;

      const { error } = await chk.client.storage
        .from(RESOURCE_BUCKET)
        .upload(key, bytes, { contentType: "application/pdf" });

      expect(error?.message ?? "").toMatch(/size|large|exceed/i);
      expect(storageHas(chk.id, key)).toBe(false);
      expect(storageCount(chk.id)).toBe(0);
    });
  });

  describe("upload rate limit", () => {
    it("answers the eleventh upload in a window with 429 and Retry-After", async () => {
      await seedSession(upl.email, upl.password);

      const accepted: number[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await upload({ title: `Flood ${attempt}` });
        expect(response.status).toBe(201);
        accepted.push(response.status);
      }
      expect(accepted).toHaveLength(10);

      const limited = await upload({ title: "One too many" });

      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(errorOf(await readJson(limited)).code).toBe("rate_limited");
      // The per-target ceiling tripped first: 10/min against this library.
      expect(rateRow(`upload:personal:${upl.id}`)?.count).toBe(11);
      expect(rowCountFor(upl.id)).toBe(10);
    });
  });

  describe("delete rate limit", () => {
    it("answers a spent delete key with 429 before the row is touched", async () => {
      await seedSession(upl.email, upl.password);
      const key = `resource_delete:user:${upl.id}`;
      for (let slot = 0; slot < 30; slot += 1) {
        const { data, error } = await upl.client.rpc("rate_limit_take", {
          p_key: key,
          p_max: 30,
          p_window: "60 seconds",
        });
        expect(error).toBeNull();
        expect(data).toBe(true);
      }

      const response = await deleteOf(randomUUID());

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(errorOf(await readJson(response)).code).toBe("rate_limited");
    });
  });

  describe("orphan cleanup", () => {
    const personalFresh = (user: TestUser) => `personal/${user.id}/fresh.pdf`;
    const personalOrphan = (user: TestUser) => `personal/${user.id}/orphan.pdf`;
    const roomOrphan = (user: TestUser, room: string) =>
      `rooms/${room}/${user.id}/orphan.pdf`;

    it("sweeps the caller's personal folder and nobody else's", async () => {
      await putObject(alice, personalOrphan(alice));
      backdateObject(personalOrphan(alice));
      await putObject(alice, personalFresh(alice));
      await putObject(bob, personalOrphan(bob));
      backdateObject(personalOrphan(bob));

      await seedSession(alice.email, alice.password);
      const response = await cleanupOf();

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        removed_objects: 1,
        removed_rows: 0,
        scope: "personal",
        room_id: null,
      });
      // Orphan gone, fresh upload still in flight, other user untouched.
      expect(storageHas(alice.id, personalOrphan(alice))).toBe(false);
      expect(storageHas(alice.id, personalFresh(alice))).toBe(true);
      expect(storageHas(bob.id, personalOrphan(bob))).toBe(true);
    });

    it("sweeps one room under the caller's own key only", async () => {
      const aliceRoomOrphan = roomOrphan(alice, roomId);
      const bobRoomOrphan = roomOrphan(bob, roomId);
      await putObject(alice, aliceRoomOrphan);
      backdateObject(aliceRoomOrphan);
      await putObject(bob, bobRoomOrphan);
      backdateObject(bobRoomOrphan);
      insertOrphanRow(
        alice.id,
        `rooms/${roomId}/${alice.id}/${randomUUID()}.pdf`,
      );
      const realRowId = randomUUID();
      const realPath = `rooms/${roomId}/${alice.id}/${realRowId}.pdf`;
      await putObject(alice, realPath);
      psql(
        "insert into public.study_resources " +
          "(id, owner_id, room_id, storage_path, title, original_filename, " +
          "content_type, size_bytes) values " +
          `('${realRowId}', '${alice.id}', '${roomId}', '${realPath}', ` +
          "'Shared for keeps', 'shared.pdf', 'application/pdf', 33);",
      );

      await seedSession(alice.email, alice.password);
      const response = await cleanupOf({ room_id: roomId });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        removed_objects: 1,
        removed_rows: 1,
        scope: "room",
        room_id: roomId,
      });
      expect(storageHas(alice.id, aliceRoomOrphan)).toBe(false);
      expect(storageHas(bob.id, bobRoomOrphan)).toBe(true);
      // The row that still has its object must survive.
      expect(
        psql(`select count(*) from public.study_resources where id = '${realRowId}';`),
      ).toBe("1");
      expect(storageHas(alice.id, realPath)).toBe(true);
    });

    it("answers a non-member's room sweep with the workspace's 404", async () => {
      await seedSession(chk.email, chk.password);

      const response = await cleanupOf({ room_id: roomId });

      expect(response.status).toBe(404);
      expect(errorOf(await readJson(response)).code).toBe("not_found");
    });

    it("answers a sixth cleanup within a minute with 429", async () => {
      await seedSession(cln.email, cln.password);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await cleanupOf();
        expect(response.status).toBe(200);
      }

      const limited = await cleanupOf();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(errorOf(await readJson(limited)).code).toBe("rate_limited");
    });
  });

  describe("storage quota", () => {
    let raceFile: File;

    it("reports the scope quota with the listing, matching the database", async () => {
      raceFile = pdfFile("race.pdf", "exactly one of these fits");
      // One byte more than one upload — the race below has room for exactly
      // one winner, whatever order the two requests land in.
      fillUserTo(alice.id, USER_LIMIT - raceFile.size - 1);

      await seedSession(alice.email, alice.password);
      const response = await listResources("?scope=personal");

      expect(response.status).toBe(200);
      const body = await readJson(response);
      const quota = body.quota as {
        scope: string;
        used_bytes: number;
        limit_bytes: number;
        user_used_bytes: number;
        user_limit_bytes: number;
      };
      expect(quota.scope).toBe("user");
      expect(quota.limit_bytes).toBe(USER_LIMIT);
      expect(quota.used_bytes).toBe(ownerSum(alice.id));
      expect(quota.user_used_bytes).toBe(ownerSum(alice.id));
      expect(quota.user_limit_bytes).toBe(USER_LIMIT);
    });

    it("pre-checks the next upload: one byte of headroom is enough, past the limit is not", async () => {
      const { data: fits, error: fitsError } = await alice.client.rpc(
        "resource_quota_ok",
        { p_room_id: null, p_add_bytes: raceFile.size },
      );
      expect(fitsError).toBeNull();
      expect(fits).toBe(true);

      const { data: over, error: overError } = await alice.client.rpc(
        "resource_quota_ok",
        { p_room_id: null, p_add_bytes: raceFile.size + 2 },
      );
      expect(overError).toBeNull();
      expect(over).toBe(false);
    });

    it("reports the room's quota alongside a room listing", async () => {
      const response = await listResources(`?room_id=${roomId}`);

      expect(response.status).toBe(200);
      const body = await readJson(response);
      const quota = body.quota as {
        scope: string;
        used_bytes: number;
        limit_bytes: number;
      };
      expect(quota.scope).toBe("room");
      expect(quota.limit_bytes).toBe(ROOM_LIMIT);
      expect(quota.used_bytes).toBe(roomSum(roomId));
    });

    it("lets exactly one of two racing uploads through", async () => {
      const rowsBefore = rowCountFor(alice.id);
      const objectsBefore = storageCount(alice.id);

      await seedSession(alice.email, alice.password);
      const [first, second] = await Promise.all([
        upload({ title: "Race winner" }, raceFile),
        upload({ title: "Race loser" }, raceFile),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const refused = first.status === 409 ? first : second;
      expect(errorOf(await readJson(refused)).code).toBe("quota_exceeded");

      // Exactly one row and one object: the loser's object is rolled back
      // whether it failed the pre-check or the trigger.
      expect(rowCountFor(alice.id)).toBe(rowsBefore + 1);
      expect(storageCount(alice.id)).toBe(objectsBefore + 1);
    });

    it("refuses the next upload with 409 and writes nothing", async () => {
      const rowsBefore = rowCountFor(alice.id);
      const objectsBefore = storageCount(alice.id);

      const response = await upload({ title: "No room left" });

      expect(response.status).toBe(409);
      expect(errorOf(await readJson(response)).code).toBe("quota_exceeded");
      expect(rowCountFor(alice.id)).toBe(rowsBefore);
      expect(storageCount(alice.id)).toBe(objectsBefore);
    });

    it("refuses a direct insert past the limit — the trigger cannot be routed around", () => {
      const id = randomUUID();
      const result = psqlExpectingFailure(
        "insert into public.study_resources " +
          "(id, owner_id, room_id, storage_path, title, original_filename, " +
          "content_type, size_bytes) values " +
          `('${id}', '${alice.id}', null, 'personal/${alice.id}/${id}.pdf', ` +
          "'Bypass attempt', 'bypass.pdf', 'application/pdf', 10);",
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("quota_exceeded");
    });

    it("returns the space the moment a file is deleted", async () => {
      const rowsBefore = rowCountFor(alice.id);
      const objectsBefore = storageCount(alice.id);
      const sumBefore = ownerSum(alice.id);
      // The largest row is a quota filler: metadata only, no object behind it,
      // so the delete frees bytes without touching storage.
      const victim = psql(
        "select id from public.study_resources " +
          `where owner_id = '${alice.id}' order by size_bytes desc limit 1;`,
      );
      expect(victim).toMatch(UUID_RE);

      await seedSession(alice.email, alice.password);
      const removed = await deleteOf(victim);

      expect(removed.status).toBe(200);
      expect(rowCountFor(alice.id)).toBe(rowsBefore - 1);
      expect(ownerSum(alice.id)).toBeLessThan(sumBefore);
      expect(storageCount(alice.id)).toBe(objectsBefore);

      // Quota is a live sum, so the freed bytes are immediately spendable.
      const retried = await upload({ title: "Room again" });

      expect(retried.status).toBe(201);
      expect(rowCountFor(alice.id)).toBe(rowsBefore);
      expect(storageCount(alice.id)).toBe(objectsBefore + 1);
    });
  });

  describe("signed download serve review", () => {
    it("serves the asset as an attachment and keeps the signature out of listings", async () => {
      await seedSession(cln.email, cln.password);
      const created = await upload(
        { title: "Serve review" },
        pdfFile("class notes.pdf", "serve review"),
      );
      expect(created.status).toBe(201);
      const createdBody = await readJson(created);
      const resourceId = (createdBody.resource as { id: string }).id;

      const download = await callApiWithParams(
        downloadGet,
        { path: `/api/resources/${resourceId}/download` },
        { id: resourceId },
      );
      expect(download.status).toBe(200);
      const body = await readJson(download);
      expect(body.expires_in).toBe(300);
      const signedUrl = String(body.url);
      // The original name rides the signed URL so storage answers with a
      // disposition the browser honours instead of rendering the bytes.
      expect(signedUrl).toContain("&download=class%20notes.pdf");

      const asset = await fetch(signedUrl, { redirect: "manual" });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("application/pdf");
      const disposition = asset.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).toContain("class notes.pdf");
      const served = Date.parse(asset.headers.get("expires") ?? "");
      const servedAt = Date.parse(asset.headers.get("date") ?? "");
      expect(Math.round((served - servedAt) / 1000)).toBe(300);
      await asset.arrayBuffer();

      const listed = await listResources("");
      const listedText = JSON.stringify(await readJson(listed));
      expect(listedText).not.toContain(signedUrl);
      expect(listedText).not.toContain("token=");
    });
  });
});
