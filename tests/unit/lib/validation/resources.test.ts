import {
  DOWNLOAD_TTL_SECONDS,
  MAX_FILE_BYTES,
  MAX_TITLE_CHARS,
  resourceListQuerySchema,
  resourceMetadataSchema,
  resourceIdSchema,
} from "@/lib/validation/resources";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

describe("resourceMetadataSchema", () => {
  it("trims the title and normalises blank optional lines", () => {
    const parsed = resourceMetadataSchema.parse({
      title: "  Rotational motion  ",
      subject: "   ",
      chapter: "",
    });

    expect(parsed).toEqual({
      title: "Rotational motion",
      subject: null,
      chapter: null,
    });
  });

  it("keeps a valid room id", () => {
    expect(resourceMetadataSchema.parse({ title: "Notes", room_id: ROOM }).room_id).toBe(
      ROOM,
    );
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const parsed = resourceMetadataSchema.safeParse({
      title: "Notes",
      owner_id: "someone-else",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain("owner_id");
  });

  const invalidMetadata: [Record<string, unknown>, string][] = [
    [{ title: "" }, "empty title"],
    [{ title: "x".repeat(MAX_TITLE_CHARS + 1) }, "title over the limit"],
    [{ title: "line\nbreak" }, "embedded newline"],
    [{ title: "Notes", room_id: "nope" }, "room id that is not a UUID"],
    [{ title: "Notes", subject: "x".repeat(81) }, "subject over the limit"],
    [{ title: "Notes", chapter: "x".repeat(81) }, "chapter over the limit"],
  ];

  it.each(invalidMetadata)("rejects %j (%s)", (body) => {
    expect(resourceMetadataSchema.safeParse(body).success).toBe(false);
  });
});

describe("resourceListQuerySchema", () => {
  it("defaults to a personal listing", () => {
    expect(resourceListQuerySchema.parse({})).toEqual({
      q: "",
      subject: null,
      chapter: null,
      limit: 50,
      offset: 0,
    });
  });

  it("accepts a room listing", () => {
    expect(resourceListQuerySchema.parse({ room_id: ROOM })).toMatchObject({
      room_id: ROOM,
    });
  });

  it("refuses a request that names both listings", () => {
    const parsed = resourceListQuerySchema.safeParse({
      scope: "personal",
      room_id: ROOM,
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain("either scope or room_id");
  });

  it("refuses a scope outside the closed list", () => {
    expect(resourceListQuerySchema.safeParse({ scope: "room" }).success).toBe(false);
  });

  it("coerces the paging parameters", () => {
    expect(resourceListQuerySchema.parse({ limit: "10", offset: "20" })).toMatchObject({
      limit: 10,
      offset: 20,
    });
  });

  const invalidQueries: [Record<string, unknown>, string][] = [
    [{ limit: "0" }, "limit below one"],
    [{ limit: "101" }, "limit over the maximum"],
    [{ limit: "2.5" }, "fractional limit"],
    [{ offset: "-1" }, "negative offset"],
    [{ q: "x".repeat(101) }, "search over the limit"],
    [{ subject: "x".repeat(81) }, "subject over the limit"],
  ];

  it.each(invalidQueries)("rejects %j (%s)", (body) => {
    expect(resourceListQuerySchema.safeParse(body).success).toBe(false);
  });
});

describe("resourceIdSchema", () => {
  it("accepts a UUID and refuses anything else", () => {
    expect(resourceIdSchema.safeParse(ROOM).success).toBe(true);
    expect(resourceIdSchema.safeParse("nope").success).toBe(false);
    expect(resourceIdSchema.safeParse("").success).toBe(false);
  });
});

describe("documented limits", () => {
  it("matches the bucket ceiling and the signed URL TTL", () => {
    expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    expect(DOWNLOAD_TTL_SECONDS).toBe(300);
  });
});
