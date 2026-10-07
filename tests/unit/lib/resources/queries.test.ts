import {
  deleteResourceMetadata,
  escapeLike,
  findResourceLocator,
  insertResource,
  listResources,
  ResourceError,
} from "@/lib/resources/queries";
import { createFakeBuilder, createFakeClient } from "../../helpers/fake-supabase";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "44444444-4444-4444-8444-444444444444";

const row = {
  id: RESOURCE,
  title: "Rotational motion",
  original_filename: "rotational.pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  subject: "Physics",
  chapter: null,
  room_id: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
  owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storage_path: "personal/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/4444.pdf",
};

const baseInput = {
  viewerId: "viewer-1",
  q: "",
  subject: null,
  chapter: null,
  limit: 50,
  offset: 0,
};

describe("escapeLike", () => {
  it("neutralises every LIKE metacharacter", () => {
    expect(escapeLike("100% off_\\ (a)")).toBe("100\\% off\\_\\\\ (a)");
  });

  it("leaves an ordinary query untouched", () => {
    expect(escapeLike("rotational motion")).toBe("rotational motion");
  });
});

describe("listResources", () => {
  it("filters a personal listing by a null room", async () => {
    const { client, state } = createFakeClient({ data: [row], error: null, count: 1 });

    const page = await listResources(client as never, { ...baseInput, scope: "personal" });

    expect(state.is).toEqual([["room_id", null]]);
    expect(state.eq).toEqual([]);
    expect(page.resources).toHaveLength(1);
    expect(page.has_more).toBe(false);
  });

  it("filters a room listing by room id", async () => {
    const { client, state } = createFakeClient({ data: [], error: null, count: 0 });

    await listResources(client as never, { ...baseInput, scope: "room", roomId: ROOM });

    expect(state.eq).toEqual([["room_id", ROOM]]);
    expect(state.is).toEqual([]);
  });

  it("throws rather than guessing a room when none was given", async () => {
    const { client } = createFakeClient({ data: [], error: null, count: 0 });

    await expect(
      listResources(client as never, { ...baseInput, scope: "room" }),
    ).rejects.toBeInstanceOf(ResourceError);
  });

  it("escapes search text before handing it to ILIKE", async () => {
    const { client, state } = createFakeClient({ data: [], error: null, count: 0 });

    await listResources(client as never, { ...baseInput, scope: "personal", q: "100% unit" });

    expect(state.ilike).toEqual([["title", "%100\\% unit%"]]);
  });

  it("matches subject and chapter literally", async () => {
    const { client, state } = createFakeClient({ data: [], error: null, count: 0 });

    await listResources(client as never, {
      ...baseInput,
      scope: "personal",
      subject: "Physics",
      chapter: "Chapter 4",
    });

    expect(state.ilike).toEqual([
      ["subject", "Physics"],
      ["chapter", "Chapter 4"],
    ]);
  });

  it("pages newest first with an exact count behind has_more", async () => {
    const { client, state } = createFakeClient({
      data: [row],
      error: null,
      count: 60,
    });

    const page = await listResources(client as never, { ...baseInput, scope: "personal" });

    expect(state.order).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(state.range).toEqual([[0, 49]]);
    expect(page.has_more).toBe(true);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });

  it("reports the end of the list once the count is reached", async () => {
    const { client } = createFakeClient({ data: [row], error: null, count: 1 });

    const page = await listResources(client as never, { ...baseInput, scope: "personal" });

    expect(page.has_more).toBe(false);
  });

  it("surfaces a query failure", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "rate limit reached" },
    });

    await expect(
      listResources(client as never, { ...baseInput, scope: "personal" }),
    ).rejects.toThrow("resource list failed");
  });
});

describe("findResourceLocator", () => {
  it("returns the locator rows carry", async () => {
    const { client } = createFakeClient({
      data: {
        id: RESOURCE,
        room_id: null,
        storage_path: row.storage_path,
      },
      error: null,
    });

    await expect(findResourceLocator(client as never, RESOURCE)).resolves.toEqual({
      id: RESOURCE,
      room_id: null,
      storage_path: row.storage_path,
    });
  });

  it("returns null when RLS hides the row", async () => {
    const { client } = createFakeClient({ data: null, error: null });

    await expect(findResourceLocator(client as never, RESOURCE)).resolves.toBeNull();
  });

  it.each([
    ["/absolute/path.pdf"],
    ["personal/../other/file.pdf"],
    [42],
  ])("refuses an unusable stored path: %j", async (storagePath) => {
    const { client } = createFakeClient({
      data: { id: RESOURCE, room_id: null, storage_path: storagePath },
      error: null,
    });

    await expect(findResourceLocator(client as never, RESOURCE)).rejects.toThrow(
      "unusable storage path",
    );
  });
});

describe("deleteResourceMetadata", () => {
  it("reports whether a row was actually removed", async () => {
    const { client, state } = createFakeClient({ data: [{ id: RESOURCE }], error: null });

    await expect(deleteResourceMetadata(client as never, RESOURCE)).resolves.toBe(true);
    expect(state.deletes).toBe(1);
  });

  it("reports false when RLS matched nothing", async () => {
    const { client } = createFakeClient({ data: [], error: null });

    await expect(deleteResourceMetadata(client as never, RESOURCE)).resolves.toBe(false);
  });

  it("maps a failure to delete_failed without leaking the message", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { message: "permission denied for table study_resources" },
    });

    const failure = await deleteResourceMetadata(client as never, RESOURCE).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ResourceError);
    expect((failure as ResourceError).status).toBe(500);
    expect((failure as ResourceError).message).not.toContain("study_resources");
  });
});

describe("insertResource", () => {
  const insert = {
    id: RESOURCE,
    roomId: null,
    storagePath: row.storage_path,
    title: "Rotational motion",
    originalFilename: "rotational.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    subject: "Physics",
    chapter: null,
  };

  it("writes the row without ever naming an owner", async () => {
    const { client, state } = createFakeClient({ data: row, error: null });

    const resource = await insertResource(client as never, insert);

    expect(state.insert[0]).not.toHaveProperty("owner_id");
    expect(state.insert[0].storage_path).toBe(row.storage_path);
    expect(resource.title).toBe("Rotational motion");
  });

  it("maps an RLS refusal to the same 404 the rest of the room API gives", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "42501", message: "new row violates policy" },
    });

    await expect(insertResource(client as never, insert)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("maps a vanished room to the same 404", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "23503", message: "violates foreign key" },
    });

    await expect(insertResource(client as never, insert)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws a plain error for an unexpected failure", async () => {
    const { client } = createFakeClient({
      data: null,
      error: { code: "57014", message: "statement timeout" },
    });

    await expect(insertResource(client as never, insert)).rejects.toThrow(
      "resource insert failed",
    );
  });
});

describe("listResources query shape", () => {
  it("asks for an exact count rather than a short page", async () => {
    const { client, state } = createFakeClient({ data: [], error: null, count: 0 });

    await listResources(client as never, { ...baseInput, scope: "personal" });

    expect(state.selectOptions[0]).toMatchObject({ count: "exact" });
    expect(state.select[0]).not.toContain("*");
  });

  it("shares a single builder across the chained calls", async () => {
    const { builder } = createFakeBuilder({ data: [], error: null });
    expect(builder.select("id")).toBe(builder);
    expect(builder.is("room_id", null)).toBe(builder);
    expect(builder.range(0, 49)).toBe(builder);
  });
});
