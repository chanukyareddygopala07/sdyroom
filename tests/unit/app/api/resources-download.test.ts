import { GET } from "@/app/api/resources/[id]/download/route";
import { ResourceError } from "@/lib/resources/queries";
import { DOWNLOAD_TTL_SECONDS } from "@/lib/validation/resources";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, findResourceLocator, createResourceDownloadUrl } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    findResourceLocator: vi.fn(),
    createResourceDownloadUrl: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/resources/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/queries")>()),
  findResourceLocator,
}));
vi.mock("@/lib/resources/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/storage")>()),
  createResourceDownloadUrl,
}));

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE = "44444444-4444-4444-8444-444444444444";
const SIGNED = `https://storage.example.com/signed/${RESOURCE}`;

function download(id: string = RESOURCE) {
  return {
    request: new NextRequest(
      `http://localhost:3000/api/resources/${id}/download`,
    ),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("GET /api/resources/[id]/download", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: OWNER } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    findResourceLocator.mockResolvedValue({
      id: RESOURCE,
      room_id: null,
      storage_path: `personal/${OWNER}/${RESOURCE}.pdf`,
    });
    createResourceDownloadUrl.mockResolvedValue({
      url: SIGNED,
      expires_in: DOWNLOAD_TTL_SECONDS,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = download();
    const response = await GET(request, context);

    expect(response.status).toBe(401);
    expect(findResourceLocator).not.toHaveBeenCalled();
    expect(createResourceDownloadUrl).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a UUID", async () => {
    const { request, context } = download("nope");

    const response = await GET(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("answers a resource the caller cannot see with the generic 404", async () => {
    findResourceLocator.mockResolvedValue(null);

    const { request, context } = download();
    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(createResourceDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns a signed URL with its lifetime and never the storage path", async () => {
    const { request, context } = download();
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      url: SIGNED,
      expires_in: DOWNLOAD_TTL_SECONDS,
      resource_id: RESOURCE,
    });
    expect(JSON.stringify(body)).not.toContain("storage_path");
    expect(JSON.stringify(body)).not.toContain("personal/");
    expect(createResourceDownloadUrl).toHaveBeenCalledWith(
      expect.anything(),
      `personal/${OWNER}/${RESOURCE}.pdf`,
    );
  });

  it("maps a denied signing to a retryable 500", async () => {
    createResourceDownloadUrl.mockRejectedValue(
      new ResourceError("download_failed", "This file could not be opened. Please try again.", 500),
    );

    const { request, context } = download();
    const response = await GET(request, context);

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("download_failed");
  });

  it("returns 500 without leaking the failure detail", async () => {
    findResourceLocator.mockRejectedValue(
      new Error("resource has an unusable storage path"),
    );

    const { request, context } = download();
    const response = await GET(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("download_failed");
    expect(JSON.stringify(body)).not.toContain("unusable storage path");
  });
});
