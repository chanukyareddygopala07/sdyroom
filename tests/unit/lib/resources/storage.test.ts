import {
  buildStoragePath,
  createResourceDownloadUrl,
  isOwnedBy,
  removeResourceObject,
  uploadResourceObject,
} from "@/lib/resources/storage";
import { ResourceError } from "@/lib/resources/queries";
import { DOWNLOAD_TTL_SECONDS } from "@/lib/validation/resources";
import { describe, expect, it, vi } from "vitest";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOM = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "44444444-4444-4444-8444-444444444444";

describe("buildStoragePath", () => {
  it("builds the personal layout from the session owner", () => {
    expect(
      buildStoragePath({ kind: "personal", ownerId: OWNER }, RESOURCE, ".pdf"),
    ).toBe(`personal/${OWNER}/${RESOURCE}.pdf`);
  });

  it("builds the room layout with room and owner in fixed positions", () => {
    expect(
      buildStoragePath({ kind: "room", roomId: ROOM, ownerId: OWNER }, RESOURCE, ".md"),
    ).toBe(`rooms/${ROOM}/${OWNER}/${RESOURCE}.md`);
  });

  it("never lets an extension escape the key", () => {
    expect(
      buildStoragePath({ kind: "personal", ownerId: OWNER }, RESOURCE, ".pdf").split("/"),
    ).toHaveLength(3);
  });
});

describe("isOwnedBy", () => {
  it("reads the uploader from a personal key", () => {
    expect(isOwnedBy(`personal/${OWNER}/${RESOURCE}.pdf`, OWNER)).toBe(true);
    expect(isOwnedBy(`personal/${OWNER}/${RESOURCE}.pdf`, OTHER)).toBe(false);
  });

  it("reads the uploader from a room key", () => {
    expect(isOwnedBy(`rooms/${ROOM}/${OWNER}/${RESOURCE}.pdf`, OWNER)).toBe(true);
    expect(isOwnedBy(`rooms/${ROOM}/${OWNER}/${RESOURCE}.pdf`, OTHER)).toBe(false);
    expect(isOwnedBy(`rooms/${ROOM}/${OWNER}/${RESOURCE}.pdf`, ROOM)).toBe(false);
  });

  it("refuses any layout the server never writes", () => {
    expect(isOwnedBy(`${OWNER}/${RESOURCE}.pdf`, OWNER)).toBe(false);
    expect(isOwnedBy(`other/${OWNER}/${RESOURCE}.pdf`, OWNER)).toBe(false);
    expect(isOwnedBy("", OWNER)).toBe(false);
  });
});

function storageClient(result: { error?: { message: string } | null; data?: unknown }) {
  return {
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => result),
        remove: vi.fn(async () => result),
        createSignedUrl: vi.fn(async () => result),
      })),
    },
  } as never;
}

describe("uploadResourceObject", () => {
  it("writes to the private bucket with upsert disabled", async () => {
    const upload = vi.fn(async () => ({ error: null }));
    const client = {
      storage: { from: vi.fn(() => ({ upload })) },
    } as never;

    await uploadResourceObject(client, `personal/${OWNER}/a.pdf`, new Uint8Array([1]), "application/pdf");

    expect(upload).toHaveBeenCalledWith(
      `personal/${OWNER}/a.pdf`,
      expect.anything(),
      { contentType: "application/pdf", upsert: false },
    );
  });

  it("maps a storage failure to a ResourceError without leaking the path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = storageClient({ error: { message: "row exceeds quota" } });

    await expect(
      uploadResourceObject(client, `personal/${OWNER}/a.pdf`, new Uint8Array(1), "application/pdf"),
    ).rejects.toMatchObject({ name: "ResourceError", code: "storage_upload_failed" });
  });
});

describe("removeResourceObject", () => {
  it("treats a removal as complete when storage reports no error", async () => {
    const remove = vi.fn(async () => ({ error: null, data: [] }));
    const client = { storage: { from: vi.fn(() => ({ remove })) } } as never;

    await expect(
      removeResourceObject(client, `personal/${OWNER}/a.pdf`),
    ).resolves.toBeUndefined();
  });

  it("maps a storage failure to cleanup_failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = storageClient({ error: { message: "boom" } });

    await expect(
      removeResourceObject(client, `personal/${OWNER}/a.pdf`),
    ).rejects.toBeInstanceOf(ResourceError);
  });
});

describe("createResourceDownloadUrl", () => {
  it("returns the caller's TTL and an absolute URL", async () => {
    const client = {
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async () => ({
            error: null,
            data: { signedUrl: "https://storage.example.com/object?token=abc" },
          })),
        })),
      },
    } as never;

    await expect(createResourceDownloadUrl(client, "personal/x/a.pdf")).resolves.toEqual({
      url: "https://storage.example.com/object?token=abc",
      expires_in: DOWNLOAD_TTL_SECONDS,
    });
  });

  it("prepends the configured origin to a relative signed URL", async () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com/";
    try {
      const client = {
        storage: {
          from: vi.fn(() => ({
            createSignedUrl: vi.fn(async () => ({
              error: null,
              data: { signedUrl: "/storage/v1/object/sign/x" },
            })),
          })),
        },
      } as never;

      await expect(createResourceDownloadUrl(client, "x")).resolves.toEqual({
        url: "https://supabase.example.com/storage/v1/object/sign/x",
        expires_in: DOWNLOAD_TTL_SECONDS,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
      }
    }
  });

  it("refuses to return a URL when signing is denied", async () => {
    const client = storageClient({
      error: { message: "Object not found" },
      data: null,
    });

    await expect(createResourceDownloadUrl(client, "x")).rejects.toMatchObject({
      code: "download_failed",
      status: 500,
    });
  });
});
