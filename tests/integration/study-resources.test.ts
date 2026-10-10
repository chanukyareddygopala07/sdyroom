import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELETE as resourceDelete } from "@/app/api/resources/[id]/route";
import { GET as resourceDownload } from "@/app/api/resources/[id]/download/route";
import {
  GET as resourcesGet,
  POST as resourcesPost,
} from "@/app/api/resources/route";
import { setModerator } from "@/lib/moderation/queries";
import { createProfile } from "@/lib/profiles/queries";
import { RESOURCE_BUCKET } from "@/lib/resources/types";
import { createRoom } from "@/lib/rooms/create";
import { joinRoom, leaveRoom } from "@/lib/rooms/membership";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql, psqlExpectingFailure } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import { integrationEnv } from "./helpers/env";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Resource = {
  id: string;
  title: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  subject: string | null;
  chapter: string | null;
  room_id: string | null;
  created_at: string;
  updated_at: string;
};

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

  return callApi(resourcesPost, {
    path: "/api/resources",
    method: "POST",
    form,
  });
}

async function listResources(query: string): Promise<Response> {
  return callApi(resourcesGet, { path: `/api/resources${query}` });
}

async function idsIn(query: string): Promise<string[]> {
  const response = await listResources(query);
  expect(response.status).toBe(200);

  const body = await readJson(response);
  return (body.resources as Resource[]).map((resource) => resource.id);
}

function downloadOf(id: string): Promise<Response> {
  return callApiWithParams(
    resourceDownload,
    { path: `/api/resources/${id}/download` },
    { id },
  );
}

function deleteOf(id: string): Promise<Response> {
  return callApiWithParams(
    resourceDelete,
    { path: `/api/resources/${id}`, method: "DELETE" },
    { id },
  );
}

/** Row count ignoring RLS — the privacy assertions' oracle. */
function resourceCountOwnedBy(userId: string): number {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Refusing to query a malformed user id: ${userId}`);
  }

  return Number(
    psql(
      `select count(*) from public.study_resources where owner_id = '${userId}';`,
    ),
  );
}

function storedPath(resourceId: string): string | null {
  const output = psql(
    `select storage_path from public.study_resources where id = '${resourceId}';`,
  );

  return output === "" ? null : output;
}

function storageNamesOwnedBy(userId: string): string[] {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Refusing to query a malformed user id: ${userId}`);
  }

  const output = psql(
    `select name from storage.objects where owner = '${userId}';`,
  );

  return output === "" ? [] : output.split("\n");
}

describe("private study files", () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let moderator: TestUser;

  let moderatorAlias: string;
  let roomId: string;

  let privateId = "";
  let sharedId = "";

  beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([
      createUser("res-alice"),
      createUser("res-bob"),
      createUser("res-carol"),
    ]);

    await Promise.all(
      [alice, bob, carol].map((user, index) =>
        createProfile(user.client, user.id, uniqueAlias(`R${index}`)),
      ),
    );

    // This user will be appointed moderator of Alice's room.
    moderator = await createUser("res-moderator");
    moderatorAlias = uniqueAlias("RM");
    await createProfile(
      moderator.client,
      moderator.id,
      moderatorAlias,
    );

    roomId = (
      await createRoom(
        alice.client,
        createRoomSchema.parse({ name: uniqueName("Files"), capacity: 4 }),
      )
    ).id;

    await joinRoom(bob.client, roomId);
    await joinRoom(moderator.client, roomId);

    await setModerator(alice.client, roomId, moderatorAlias, true);
  });

  afterAll(async () => {
    // Remove objects while their owner is still available. These fixture
    // clients use their own authenticated sessions, not a service-role key.
    for (const user of [alice, bob, carol, moderator]) {
      const names = storageNamesOwnedBy(user.id);

      if (names.length > 0) {
        await user.client.storage.from(RESOURCE_BUCKET).remove(names);
      }
    }

    clearCookies();
    await deleteUsers([alice, bob, carol, moderator]);
  });

  describe("personal library", () => {
    it("stores a private file and exposes no internal columns", async () => {
      await seedSession(alice.email, alice.password);

      const response = await upload({ title: "Rotational motion" });

      expect(response.status).toBe(201);

      const body = await readJson(response);
      const resource = body.resource as Resource;
      privateId = resource.id;

      expect(privateId).toMatch(UUID_RE);
      expect(resource.room_id).toBeNull();
      expect(resource.content_type).toBe("application/pdf");
      expect(resource.size_bytes).toBeGreaterThan(0);
      expect(resource).not.toHaveProperty("owner_id");
      expect(resource).not.toHaveProperty("storage_path");

      expect(storedPath(privateId)).toMatch(
        new RegExp(`^personal/${alice.id}/[0-9a-f-]{36}\\.pdf$`),
      );
      expect(resourceCountOwnedBy(alice.id)).toBe(1);
    });

    it("shows the file only to its owner", async () => {
      await seedSession(alice.email, alice.password);
      expect(await idsIn("?scope=personal")).toContain(privateId);

      await seedSession(bob.email, bob.password);
      expect(await idsIn("?scope=personal")).not.toContain(privateId);
      expect(resourceCountOwnedBy(bob.id)).toBe(0);
    });

    it("refuses an anonymous listing", async () => {
      clearCookies();

      const response = await listResources("?scope=personal");

      expect(response.status).toBe(401);
      expect(errorOf(await readJson(response)).code).toBe("unauthenticated");
    });

    it("issues the owner a short-lived signed URL", async () => {
      await seedSession(alice.email, alice.password);

      const response = await downloadOf(privateId);

      expect(response.status).toBe(200);

      const body = await readJson(response);
      expect(body.expires_in).toBe(300);
      expect(body.resource_id).toBe(privateId);
      expect(String(body.url)).toMatch(/^https?:\/\//);

      const file = await fetch(String(body.url));
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("pdf");
    });

    it("leaves the object unreachable without a signature", async () => {
      const { apiUrl } = integrationEnv();
      const path = storedPath(privateId);

      expect(path).not.toBeNull();

      const response = await fetch(
        `${apiUrl}/storage/v1/object/${RESOURCE_BUCKET}/${path}`,
      );

      expect(response.ok).toBe(false);
    });

    it("refuses to open another student's file", async () => {
      await seedSession(bob.email, bob.password);

      const response = await downloadOf(privateId);

      expect(response.status).toBe(404);
      expect(errorOf(await readJson(response)).code).toBe("not_found");
    });

    it("refuses to let another student delete the file", async () => {
      await seedSession(bob.email, bob.password);

      const response = await deleteOf(privateId);

      expect(response.status).toBe(404);
      expect(resourceCountOwnedBy(alice.id)).toBe(1);
      expect(storedPath(privateId)).not.toBeNull();
    });

    it("keeps personal files uploader-only even from a room moderator", async () => {
      await seedSession(moderator.email, moderator.password);

      const response = await deleteOf(privateId);

      expect(response.status).toBe(404);
      expect(resourceCountOwnedBy(alice.id)).toBe(1);
      expect(storedPath(privateId)).not.toBeNull();
    });

    it("removes both the row and the object for the owner", async () => {
      await seedSession(alice.email, alice.password);

      const response = await deleteOf(privateId);

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ deleted: true });
      expect(resourceCountOwnedBy(alice.id)).toBe(0);
      expect(storedPath(privateId)).toBeNull();

      const again = await downloadOf(privateId);
      expect(again.status).toBe(404);
    });
  });

  describe("room sharing", () => {
    it("shares a file into a room the uploader belongs to", async () => {
      await seedSession(alice.email, alice.password);

      const response = await upload({
        title: "Shared problem set",
        room_id: roomId,
        subject: "Physics",
        chapter: "Rotational motion",
      });

      expect(response.status).toBe(201);

      const resource = (await readJson(response)).resource as Resource;
      sharedId = resource.id;

      expect(resource.room_id).toBe(roomId);
      expect(resource.subject).toBe("Physics");
      expect(storedPath(sharedId)).toMatch(
        new RegExp(`^rooms/${roomId}/${alice.id}/`),
      );
    });

    it("lets every current member read and open it", async () => {
      await seedSession(bob.email, bob.password);

      expect(await idsIn(`?room_id=${roomId}`)).toContain(sharedId);

      // A shared file never lands in the personal library.
      expect(await idsIn("?scope=personal")).not.toContain(sharedId);

      const download = await downloadOf(sharedId);
      expect(download.status).toBe(200);
      expect((await readJson(download)).expires_in).toBe(300);
    });

    it("answers a non-member with the workspace's 404", async () => {
      await seedSession(carol.email, carol.password);

      const listing = await listResources(`?room_id=${roomId}`);
      expect(listing.status).toBe(404);
      expect(errorOf(await readJson(listing)).code).toBe("not_found");

      const download = await downloadOf(sharedId);
      expect(download.status).toBe(404);
    });

    it("does not let a member delete somebody else's upload", async () => {
      await seedSession(bob.email, bob.password);

      const response = await deleteOf(sharedId);

      expect(response.status).toBe(404);
      expect(resourceCountOwnedBy(alice.id)).toBe(1);
      expect(storedPath(sharedId)).not.toBeNull();
    });

    it("lets an appointed moderator delete another member's upload and records an audit row", async () => {
      // Bob uploads a shared resource.
      await seedSession(bob.email, bob.password);

      const created = await upload({
        title: "Moderator deletion test",
        room_id: roomId,
      });

      expect(created.status).toBe(201);

      const resource = (await readJson(created)).resource as Resource;

      expect(resource.room_id).toBe(roomId);
      expect(storedPath(resource.id)).toMatch(
        new RegExp(`^rooms/${roomId}/${bob.id}/`),
      );
      expect(resourceCountOwnedBy(bob.id)).toBe(1);

      // The appointed moderator deletes Bob's resource.
      await seedSession(moderator.email, moderator.password);

      const response = await deleteOf(resource.id);

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ deleted: true });

      // Verify both the resource metadata and Storage object are gone.
      expect(storedPath(resource.id)).toBeNull();
      expect(resourceCountOwnedBy(bob.id)).toBe(0);

      // The audit record must name the room, actor, action, and resource.
      expect(
        psql(
          `select count(*) from public.moderation_actions ` +
            `where room_id = '${roomId}' ` +
            `and actor_id = '${moderator.id}' ` +
            `and action = 'resource_removed' ` +
            `and subject_ref = '${resource.id}';`,
        ),
      ).toBe("1");
    });

    it("revokes access the moment the reader leaves the room", async () => {
      expect((await leaveRoom(bob.client, roomId)).membership).toBe("left");

      await seedSession(bob.email, bob.password);

      const listing = await listResources(`?room_id=${roomId}`);
      expect(listing.status).toBe(404);

      // The download path relies on RLS to revoke access.
      const download = await downloadOf(sharedId);
      expect(download.status).toBe(404);

      // The uploader is unaffected — it is still their file.
      await seedSession(alice.email, alice.password);
      expect(await idsIn(`?room_id=${roomId}`)).toContain(sharedId);
    });
  });

  describe("forged input", () => {
    it("rejects an owner_id field instead of silently ignoring it", async () => {
      await seedSession(bob.email, bob.password);

      const before = resourceCountOwnedBy(alice.id);
      const response = await upload({
        title: "Notes",
        owner_id: alice.id,
      });

      expect(response.status).toBe(400);

      const error = errorOf(await readJson(response));
      expect(error.code).toBe("invalid_request");
      expect(error.issues).toEqual([
        { path: "owner_id", message: "Not accepted here." },
      ]);
      expect(resourceCountOwnedBy(alice.id)).toBe(before);
    });

    it("refuses to share into a room the caller has left", async () => {
      const before = resourceCountOwnedBy(bob.id);
      const response = await upload({
        title: "Notes",
        room_id: roomId,
      });

      expect(response.status).toBe(404);
      expect(errorOf(await readJson(response)).code).toBe("not_found");
      expect(resourceCountOwnedBy(bob.id)).toBe(before);
    });

    it("refuses a file whose bytes do not match its extension", async () => {
      await seedSession(bob.email, bob.password);

      const impostor = new File(
        [new TextEncoder().encode("plain text")],
        "notes.pdf",
        { type: "application/pdf" },
      );

      const response = await upload({ title: "Notes" }, impostor);

      expect(response.status).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe("malformed_file");
    });
  });

  describe("storage policies", () => {
    it("refuses a write into another student's personal folder", async () => {
      const { error } = await bob.client.storage
        .from(RESOURCE_BUCKET)
        .upload(
          `personal/${alice.id}/intruder.pdf`,
          new Uint8Array([1, 2, 3]),
          {
            contentType: "application/pdf",
            upsert: false,
          },
        );

      expect(error).not.toBeNull();
      expect(storageNamesOwnedBy(alice.id)).not.toContain(
        `personal/${alice.id}/intruder.pdf`,
      );
    });

    it("refuses to sign another student's object", async () => {
      const names = storageNamesOwnedBy(alice.id);
      expect(names.length).toBeGreaterThan(0);

      const { error, data } = await bob.client.storage
        .from(RESOURCE_BUCKET)
        .createSignedUrl(names[0], 300);

      expect(error).not.toBeNull();
      expect(data?.signedUrl).toBeUndefined();
    });

    it("refuses to delete another student's object", async () => {
      const names = storageNamesOwnedBy(alice.id);
      expect(names.length).toBeGreaterThan(0);

      // Storage may return no error if RLS filters out all matching rows,
      // so assert that the other user's objects survive.
      await bob.client.storage.from(RESOURCE_BUCKET).remove(names);

      expect(storageNamesOwnedBy(alice.id)).toEqual(names);
    });
  });

  describe("schema shape", () => {
    it("keeps the bucket private", () => {
      expect(
        psql("select public from storage.buckets where id = 'study-resources';"),
      ).toBe("f");

      expect(
        psql(
          "select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;",
        ),
      ).toBe("t");
    });

    it("grants no verb on owner_id to the API role", () => {
      expect(
        psql(
          "select has_column_privilege('authenticated', 'public.study_resources', 'owner_id', 'SELECT');",
        ),
      ).toBe("f");

      expect(
        psql(
          "select has_column_privilege('authenticated', 'public.study_resources', 'owner_id', 'INSERT');",
        ),
      ).toBe("f");

      expect(
        psql(
          "select has_column_privilege('authenticated', 'public.study_resources', 'storage_path', 'SELECT');",
        ),
      ).toBe("t");
    });

    it("rejects a hand-written row that points outside the key layout", () => {
      // Not under the personal prefix at all: scope and key cannot disagree.
      const wrongScope = psqlExpectingFailure(
        "insert into public.study_resources " +
          "(owner_id, room_id, storage_path, title, original_filename, content_type, size_bytes) " +
          `values ('${alice.id}', null, '../../etc/passwd', 'x', 'x.pdf', 'application/pdf', 1);`,
      );

      expect(wrongScope.output).toContain(
        "study_resources_scope_matches_path",
      );

      // Under the right prefix but still not a server-built key.
      const wrongShape = psqlExpectingFailure(
        "insert into public.study_resources " +
          "(owner_id, room_id, storage_path, title, original_filename, content_type, size_bytes) " +
          `values ('${alice.id}', null, 'personal/${alice.id}/../../x.pdf', 'x', 'x.pdf', 'application/pdf', 1);`,
      );

      expect(wrongShape.output).toContain(
        "study_resources_storage_path_layout",
      );

      expect(resourceCountOwnedBy(alice.id)).toBe(1);
    });
  });
});