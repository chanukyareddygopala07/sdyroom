import { GET, POST } from "@/app/api/resources/route";
import { ResourceError } from "@/lib/resources/queries";
import { RoomAccessError } from "@/lib/rooms/access";
import { MAX_FILE_BYTES } from "@/lib/validation/resources";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  listResources,
  insertResource,
  uploadResourceObject,
  removeResourceObject,
  requireRoomMembership,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  listResources: vi.fn(),
  insertResource: vi.fn(),
  uploadResourceObject: vi.fn(),
  removeResourceObject: vi.fn(),
  requireRoomMembership: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/resources/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/queries")>()),
  listResources,
  insertResource,
}));
vi.mock("@/lib/resources/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/storage")>()),
  uploadResourceObject,
  removeResourceObject,
}));
vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const storedResource = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Rotational motion",
  original_filename: "rotational.pdf",
  content_type: "application/pdf",
  size_bytes: 12,
  subject: null,
  chapter: null,
  room_id: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
};

function get(query = "") {
  return new NextRequest(`http://localhost:3000/api/resources${query}`);
}

function pdfFile(name = "notes.pdf", content = "%PDF-1.4\nx\n"): File {
  return new File([new TextEncoder().encode(content)], name, {
    type: "application/pdf",
  });
}

function uploadBody(
  fields: Record<string, string> = {},
  file: File | null = pdfFile(),
): NextRequest {
  const form = new FormData();
  if (file !== null) form.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return new NextRequest("http://localhost:3000/api/resources", {
    method: "POST",
    body: form,
  });
}

describe("GET /api/resources", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    listResources.mockResolvedValue({
      resources: [storedResource],
      limit: 50,
      offset: 0,
      has_more: false,
    });
    requireRoomMembership.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(get("?scope=personal"));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(listResources).not.toHaveBeenCalled();
  });

  it("lists the caller's personal library by default", async () => {
    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resources: [storedResource],
      limit: 50,
      offset: 0,
      has_more: false,
    });
    expect(listResources).toHaveBeenCalledWith(expect.anything(), {
      viewerId: "user-1",
      scope: "personal",
      roomId: undefined,
      q: "",
      subject: null,
      chapter: null,
      limit: 50,
      offset: 0,
    });
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("refuses a query that names both listings", async () => {
    const response = await GET(get(`?scope=personal&room_id=${ROOM_ID}`));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(listResources).not.toHaveBeenCalled();
  });

  it("refuses a limit above the documented maximum", async () => {
    const response = await GET(get("?limit=5000"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("confirms room membership before listing a room", async () => {
    const response = await GET(get(`?room_id=${ROOM_ID}`));

    expect(response.status).toBe(200);
    expect(requireRoomMembership).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    expect(listResources).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "room", roomId: ROOM_ID }),
    );
  });

  it("answers a non-member with the workspace's 404", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const response = await GET(get(`?room_id=${ROOM_ID}`));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(listResources).not.toHaveBeenCalled();
  });

  it("maps a ResourceError to its own status and code", async () => {
    listResources.mockRejectedValue(
      new ResourceError("not_found", "That resource does not exist or is not available.", 404),
    );

    const response = await GET(get());

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 500 without leaking the database error", async () => {
    listResources.mockRejectedValue(new Error("relation does not exist"));

    const response = await GET(get());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("resources_failed");
    expect(JSON.stringify(body)).not.toContain("relation does not exist");
  });
});

describe("POST /api/resources", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    listResources.mockResolvedValue({
      resources: [],
      limit: 50,
      offset: 0,
      has_more: false,
    });
    insertResource.mockResolvedValue(storedResource);
    uploadResourceObject.mockResolvedValue(undefined);
    removeResourceObject.mockResolvedValue(undefined);
    requireRoomMembership.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await POST(uploadBody({ title: "Notes" }));

    expect(response.status).toBe(401);
    expect(uploadResourceObject).not.toHaveBeenCalled();
    expect(insertResource).not.toHaveBeenCalled();
  });

  it("refuses a request larger than the file ceiling plus envelope slack", async () => {
    const request = new NextRequest("http://localhost:3000/api/resources", {
      method: "POST",
      headers: { "content-length": String(MAX_FILE_BYTES + 1024 * 1024) },
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("file_too_large");
    expect(uploadResourceObject).not.toHaveBeenCalled();
  });

  it("refuses a body that is not multipart form data", async () => {
    const request = new NextRequest("http://localhost:3000/api/resources", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not a form",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("rejects an unexpected field instead of ignoring it", async () => {
    const response = await POST(uploadBody({ title: "Notes", owner_id: "someone" }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues).toEqual([
      { path: "owner_id", message: "Not accepted here." },
    ]);
    expect(uploadResourceObject).not.toHaveBeenCalled();
  });

  it("rejects a missing title", async () => {
    const response = await POST(uploadBody({}));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(uploadResourceObject).not.toHaveBeenCalled();
  });

  it("rejects a file outside the closed extension list with 415", async () => {
    const response = await POST(
      uploadBody({ title: "Notes" }, new File(["MZ"], "setup.exe")),
    );

    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("unsupported_file_type");
    expect(uploadResourceObject).not.toHaveBeenCalled();
  });

  it("answers a non-member sharing into a room with the workspace's 404", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const response = await POST(uploadBody({ title: "Notes", room_id: ROOM_ID }));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(uploadResourceObject).not.toHaveBeenCalled();
  });

  it("stores a personal file under the session owner's own key", async () => {
    const response = await POST(uploadBody({ title: "Rotational motion" }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.resource).toEqual(storedResource);
    expect(uploadResourceObject).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^personal\/user-1\/[0-9a-f-]{36}\.pdf$/),
      expect.anything(),
      "application/pdf",
    );
    expect(insertResource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ roomId: null, title: "Rotational motion" }),
    );
  });

  it("stores a shared file under the room's key", async () => {
    const response = await POST(
      uploadBody({ title: "Shared notes", room_id: ROOM_ID }),
    );

    expect(response.status).toBe(201);
    expect(uploadResourceObject).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(new RegExp(`^rooms/${ROOM_ID}/user-1/`)),
      expect.anything(),
      "application/pdf",
    );
    expect(insertResource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ roomId: ROOM_ID }),
    );
  });

  it("maps a storage failure to 500 without writing metadata", async () => {
    uploadResourceObject.mockRejectedValue(
      new ResourceError("storage_upload_failed", "The file could not be saved. Please try again.", 500),
    );

    const response = await POST(uploadBody({ title: "Notes" }));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("storage_upload_failed");
    expect(insertResource).not.toHaveBeenCalled();
    expect(removeResourceObject).not.toHaveBeenCalled();
  });

  it("removes the object when the metadata row cannot be written", async () => {
    insertResource.mockRejectedValue(
      new ResourceError("not_found", "That resource does not exist or is not available.", 404),
    );

    const response = await POST(uploadBody({ title: "Notes" }));

    expect(response.status).toBe(404);
    expect(removeResourceObject).toHaveBeenCalledTimes(1);
    expect(removeResourceObject.mock.calls[0]?.[1]).toMatch(
      /^personal\/user-1\//,
    );
  });

  it("returns 500 for an unexpected metadata failure after rolling back", async () => {
    insertResource.mockRejectedValue(new Error("statement timeout"));

    const response = await POST(uploadBody({ title: "Notes" }));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("metadata_failed");
    expect(JSON.stringify(body)).not.toContain("statement timeout");
    expect(removeResourceObject).toHaveBeenCalledTimes(1);
  });
});
