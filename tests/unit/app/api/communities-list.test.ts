import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, rateLimitedResponse, listCommunities, createCommunity } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    rateLimitedResponse: vi.fn(async (): Promise<Response | null> => null),
    listCommunities: vi.fn(),
    createCommunity: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", () => ({ rateLimitedResponse }));
vi.mock("@/lib/communities/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/queries")>()),
  listCommunities,
  createCommunity,
}));

import { GET, POST } from "@/app/api/communities/route";
import { CommunityAccessError } from "@/lib/communities/access";
import { CommunityError } from "@/lib/communities/queries";

const BODY = { slug: "study-hall", name: "Study Hall" };

function getRequest(query = "") {
  return new NextRequest(`http://localhost:3000/api/communities${query}`);
}

function postRequest(body: BodyInit) {
  return new NextRequest("http://localhost:3000/api/communities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  rateLimitedResponse.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/communities", () => {
  it("401s signed-out callers before touching queries", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(listCommunities).not.toHaveBeenCalled();
  });

  it("rejects out-of-range query params with 400 validation", async () => {
    const response = await GET(getRequest("?limit=999"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(listCommunities).not.toHaveBeenCalled();
  });

  it("returns the discovery page and passes filters through", async () => {
    listCommunities.mockResolvedValue({
      communities: [{ id: "c1" }],
      has_more: false,
    });
    const response = await GET(getRequest("?category=exams&q=jee"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      communities: [{ id: "c1" }],
      has_more: false,
    });
    expect(listCommunities).toHaveBeenCalledWith(expect.anything(), {
      category: "exams",
      q: "jee",
      limit: 20,
    });
  });

  it("maps query-layer failures to 500 communities_failed", async () => {
    listCommunities.mockRejectedValue(new Error("boom"));
    const response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("communities_failed");
  });

  it("passes a CommunityError through with its own status", async () => {
    listCommunities.mockRejectedValue(
      new CommunityError("communities_failed", "nope", 500),
    );
    const response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("communities_failed");
  });
});

describe("POST /api/communities", () => {
  it("401s signed-out callers", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await POST(postRequest(JSON.stringify(BODY)));
    expect(response.status).toBe(401);
    expect(createCommunity).not.toHaveBeenCalled();
  });

  it("rejects non-JSON bodies with invalid_json", async () => {
    const response = await POST(postRequest("=not json="));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("rejects schema failures with validation", async () => {
    const response = await POST(postRequest(JSON.stringify({ slug: "x", name: "n" })));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(createCommunity).not.toHaveBeenCalled();
  });

  it("returns the rate-limit response when throttled", async () => {
    rateLimitedResponse.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "rate_limited", message: "slow" } }),
        { status: 429, headers: { "retry-after": "60" } },
      ),
    );
    const response = await POST(postRequest(JSON.stringify(BODY)));
    expect(response.status).toBe(429);
    expect(createCommunity).not.toHaveBeenCalled();
  });

  it("creates the community with owner bookkeeping pinned by the RPC", async () => {
    createCommunity.mockResolvedValue({ id: "c1", slug: "study-hall" });
    const response = await POST(postRequest(JSON.stringify(BODY)));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      community: { id: "c1", slug: "study-hall" },
    });
    expect(createCommunity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        slug: "study-hall",
        joinPolicy: "open",
        description: "",
        rules: "",
      }),
    );
  });

  it("forces request-based joining for private communities", async () => {
    createCommunity.mockResolvedValue({ id: "c1" });
    const response = await POST(
      postRequest(JSON.stringify({ ...BODY, visibility: "private" })),
    );
    expect(response.status).toBe(201);
    expect(createCommunity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ visibility: "private", joinPolicy: "request" }),
    );
  });

  it("maps slug conflicts, access errors and unexpected failures", async () => {
    createCommunity.mockRejectedValueOnce(
      new CommunityError("slug_taken", "taken", 409),
    );
    const conflict = await POST(postRequest(JSON.stringify(BODY)));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("slug_taken");

    createCommunity.mockRejectedValueOnce(
      new CommunityAccessError("forbidden", "no", 403),
    );
    const access = await POST(postRequest(JSON.stringify(BODY)));
    expect(access.status).toBe(403);

    createCommunity.mockRejectedValueOnce(new Error("boom"));
    const failed = await POST(postRequest(JSON.stringify(BODY)));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("community_create_failed");
  });
});
