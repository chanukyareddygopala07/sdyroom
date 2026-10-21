import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  getCommunityChannel,
  createCommunityAttachment,
  getCommunityAttachment,
  createCommunityReport,
  searchGifs,
  fetchGif,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(async (): Promise<Response | null> => null),
  getCommunityChannel: vi.fn(),
  createCommunityAttachment: vi.fn(),
  getCommunityAttachment: vi.fn(),
  createCommunityReport: vi.fn(),
  searchGifs: vi.fn(),
  fetchGif: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", () => ({ rateLimitedResponse }));
vi.mock("@/lib/communities/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/queries")>()),
  getCommunityChannel,
  createCommunityAttachment,
  getCommunityAttachment,
  createCommunityReport,
}));
vi.mock("@/lib/communities/gif", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/gif")>()),
  searchGifs,
  fetchGif,
}));

import { POST as createAttachment } from "@/app/api/communities/[id]/attachments/route";
import { GET as downloadAttachment } from "@/app/api/communities/[id]/attachments/[attachmentId]/route";
import { POST as createReport } from "@/app/api/communities/[id]/reports/route";
import { GET as gifSearch } from "@/app/api/communities/gif/search/route";
import { POST as gifFetch } from "@/app/api/communities/gif/fetch/route";
import { CommunityError } from "@/lib/communities/queries";
import { GifProxyError } from "@/lib/communities/gif";

const ID = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const CHANNEL = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";
const ATTACHMENT = "5a7b8c9d-0e1f-4a2b-b3c4-d5e6f7a8b9c0";
const USER = "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };

function useDb(
  tables: Record<string, Result[]>,
  signed: Result[] = [{ data: { signedUrl: "https://sign.example/object" }, error: null }],
) {
  const queues = new Map<string, Result[]>(
    Object.entries(tables).map(([table, results]) => [table, [...results]]),
  );
  const signedQueue = [...signed];
  const client = {
    from(table: string) {
      const take = (): Result => queues.get(table)?.shift() ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const method = () => () => chain;
      for (const name of ["select", "eq", "order", "limit", "insert", "update", "delete", "lt"]) {
        chain[name] = method();
      }
      const resolved = () => Promise.resolve(take());
      chain.maybeSingle = () => resolved();
      chain.single = () => resolved();
      chain.then = (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => resolved().then(onFulfilled, onRejected);
      return chain;
    },
    storage: {
      from() {
        return {
          createSignedUrl: () =>
            Promise.resolve(signedQueue.shift() ?? { data: null, error: { message: "no" } }),
        };
      },
    },
  };
  createClient.mockResolvedValue({ auth: { getClaims }, from: client.from, storage: client.storage });
  return client;
}

function ctx(id: string = ID, attachmentId: string = ATTACHMENT) {
  return { params: Promise.resolve({ id, attachmentId }) };
}

function post(path: string, body: BodyInit) {
  return new NextRequest(`http://localhost:3000/api/communities${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function get(path: string) {
  return new NextRequest(`http://localhost:3000/api/communities${path}`);
}

const ATTACHMENT_BODY = {
  channelId: CHANNEL,
  storagePath: `community-attachments/${ID}/${CHANNEL}/${ATTACHMENT}`,
  ciphertextSize: 2048,
  contentType: "image/png",
};

const REPORT_BODY = {
  targetType: "message",
  targetId: "msg-1",
  reason: "Harassment",
};

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  rateLimitedResponse.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/communities/[id]/attachments", () => {
  it("stores ciphertext metadata for an active member", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    createCommunityAttachment.mockResolvedValue({ id: ATTACHMENT });

    const response = await createAttachment(
      post(`/${ID}/attachments`, JSON.stringify(ATTACHMENT_BODY)),
      ctx(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ attachment: { id: ATTACHMENT } });
    expect(createCommunityAttachment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        communityId: ID,
        channelId: CHANNEL,
        uploaderId: USER,
        storagePath: ATTACHMENT_BODY.storagePath,
        ciphertextSize: 2048,
        contentType: "image/png",
      }),
    );
  });

  it("covers auth, id, body, schema and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect(
      (await createAttachment(post(`/${ID}/attachments`, JSON.stringify(ATTACHMENT_BODY)), ctx())).status,
    ).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect(
      (await createAttachment(post(`/nope/attachments`, JSON.stringify(ATTACHMENT_BODY)), ctx("nope"))).status,
    ).toBe(400);
    expect(
      (await createAttachment(post(`/${ID}/attachments`, "oops"), ctx())).status,
    ).toBe(400);

    const badPath = await createAttachment(
      post(`/${ID}/attachments`, JSON.stringify({ ...ATTACHMENT_BODY, storagePath: "evil/path" })),
      ctx(),
    );
    expect(badPath.status).toBe(400);

    const huge = await createAttachment(
      post(`/${ID}/attachments`, JSON.stringify({ ...ATTACHMENT_BODY, ciphertextSize: 0 })),
      ctx(),
    );
    expect(huge.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect(
      (await createAttachment(post(`/${ID}/attachments`, JSON.stringify(ATTACHMENT_BODY)), ctx())).status,
    ).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("maps access, channel and prefix failures", async () => {
    useDb({ community_members: [{ data: null, error: null }] });
    expect(
      (await createAttachment(post(`/${ID}/attachments`, JSON.stringify(ATTACHMENT_BODY)), ctx())).status,
    ).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockRejectedValueOnce(
      new CommunityError("not_found", "gone", 404),
    );
    expect(
      (await createAttachment(post(`/${ID}/attachments`, JSON.stringify(ATTACHMENT_BODY)), ctx())).status,
    ).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    const wrongPrefix = await createAttachment(
      post(`/${ID}/attachments`, JSON.stringify({ ...ATTACHMENT_BODY, storagePath: `community-attachments/${ID}/4a5b6c7d-8e9f-40a1-b2c3-d4e5f6a7b8c9/${ATTACHMENT}` })),
      ctx(),
    );
    expect(wrongPrefix.status).toBe(400);
    expect((await wrongPrefix.json()).error.message).toMatch(/inside this community/);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    createCommunityAttachment.mockRejectedValueOnce(new Error("boom"));
    const failed = await createAttachment(
      post(`/${ID}/attachments`, JSON.stringify(ATTACHMENT_BODY)),
      ctx(),
    );
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("attachment_create_failed");
  });
});

describe("GET /api/communities/[id]/attachments/[attachmentId]", () => {
  it("returns a short-lived signed URL for members", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityAttachment.mockResolvedValue({ storage_path: ATTACHMENT_BODY.storagePath });

    const response = await downloadAttachment(get(`/${ID}/attachments/${ATTACHMENT}`), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://sign.example/object",
      expires_in: 120,
    });
  });

  it("covers auth, id and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await downloadAttachment(get(`/${ID}/attachments/${ATTACHMENT}`), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await downloadAttachment(get(`/nope/attachments/${ATTACHMENT}`), ctx("nope"))).status).toBe(400);
    expect((await downloadAttachment(get(`/${ID}/attachments/nope`), ctx(ID, "nope"))).status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await downloadAttachment(get(`/${ID}/attachments/${ATTACHMENT}`), ctx())).status).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("maps hidden rows, missing attachments and signing failures", async () => {
    useDb({ community_members: [{ data: null, error: null }] });
    expect((await downloadAttachment(get(`/${ID}/attachments/${ATTACHMENT}`), ctx())).status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityAttachment.mockRejectedValueOnce(
      new CommunityError("not_found", "gone", 404),
    );
    expect((await downloadAttachment(get(`/${ID}/attachments/${ATTACHMENT}`), ctx())).status).toBe(404);

    useDb(
      { community_members: [{ data: { role: "member", status: "active" } }] },
      [{ data: null, error: { message: "object gone" } }],
    );
    getCommunityAttachment.mockResolvedValue({ storage_path: ATTACHMENT_BODY.storagePath });
    const failed = await downloadAttachment(get(`/${ID}/attachments/${ATTACHMENT}`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("attachment_url_failed");
  });
});

describe("POST /api/communities/[id]/reports", () => {
  it("files a report with a voluntary excerpt", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    createCommunityReport.mockResolvedValue({ id: "r1" });

    const response = await createReport(
      post(`/${ID}/reports`, JSON.stringify({ ...REPORT_BODY, contextExcerpt: "the words" })),
      ctx(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ report: { id: "r1" } });
    expect(createCommunityReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        communityId: ID,
        reporterId: USER,
        targetType: "message",
        contextExcerpt: "the words",
      }),
    );
  });

  it("defaults a missing excerpt to null", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    createCommunityReport.mockResolvedValue({ id: "r2" });
    const response = await createReport(
      post(`/${ID}/reports`, JSON.stringify(REPORT_BODY)),
      ctx(),
    );
    expect(response.status).toBe(201);
    expect(createCommunityReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextExcerpt: null }),
    );
  });

  it("covers auth, id, body, schema and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await createReport(post(`/${ID}/reports`, JSON.stringify(REPORT_BODY)), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await createReport(post(`/nope/reports`, JSON.stringify(REPORT_BODY)), ctx("nope"))).status).toBe(400);
    expect((await createReport(post(`/${ID}/reports`, "oops"), ctx())).status).toBe(400);

    const badTarget = await createReport(
      post(`/${ID}/reports`, JSON.stringify({ ...REPORT_BODY, targetType: "channel" })),
      ctx(),
    );
    expect(badTarget.status).toBe(400);

    const noReason = await createReport(
      post(`/${ID}/reports`, JSON.stringify({ ...REPORT_BODY, reason: "  " })),
      ctx(),
    );
    expect(noReason.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await createReport(post(`/${ID}/reports`, JSON.stringify(REPORT_BODY)), ctx())).status).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("maps access failures and unexpected errors", async () => {
    useDb({ community_members: [{ data: null, error: null }] });
    expect((await createReport(post(`/${ID}/reports`, JSON.stringify(REPORT_BODY)), ctx())).status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    createCommunityReport.mockRejectedValueOnce(new Error("boom"));
    const failed = await createReport(post(`/${ID}/reports`, JSON.stringify(REPORT_BODY)), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("report_create_failed");
  });
});

describe("GET /api/communities/gif/search", () => {
  it("returns normalized GIFs for a signed-in caller", async () => {
    const gifs = [{ id: "g1", preview_url: "p", full_url: "f", width: 100, height: 80 }];
    searchGifs.mockResolvedValue(gifs);

    const response = await gifSearch(get("/gif/search?q=hello"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gifs });
    expect(searchGifs).toHaveBeenCalledWith("hello");
  });

  it("covers auth, query and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await gifSearch(get("/gif/search?q=hello"))).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await gifSearch(get("/gif/search"))).status).toBe(400);
    expect((await gifSearch(get("/gif/search?q="))).status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await gifSearch(get("/gif/search?q=hello"))).status).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("answers 503 when the provider is unconfigured and 502 on provider errors", async () => {
    searchGifs.mockRejectedValueOnce(
      new GifProxyError("gif_unavailable", "no provider", 503),
    );
    const unavailable = await gifSearch(get("/gif/search?q=hello"));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("gif_unavailable");

    searchGifs.mockRejectedValueOnce(
      new GifProxyError("gif_provider_failed", "upstream 500", 502),
    );
    const upstream = await gifSearch(get("/gif/search?q=hello"));
    expect(upstream.status).toBe(502);

    searchGifs.mockRejectedValueOnce(new Error("boom"));
    const failed = await gifSearch(get("/gif/search?q=hello"));
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe("gif_provider_failed");
  });
});

describe("POST /api/communities/gif/fetch", () => {
  const url = "https://media.provider.example/tenor/g1.gif";

  it("returns the GIF bytes with a private cache header", async () => {
    fetchGif.mockResolvedValue({ bytes: new Uint8Array([0x47, 0x49, 0x46]) });

    const response = await gifFetch(post("/gif/fetch", JSON.stringify({ url })));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x47, 0x49, 0x46]),
    );
    expect(fetchGif).toHaveBeenCalledWith(url);
  });

  it("covers auth, body, schema and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await gifFetch(post("/gif/fetch", JSON.stringify({ url })))).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await gifFetch(post("/gif/fetch", "oops"))).status).toBe(400);

    const badUrl = await gifFetch(post("/gif/fetch", JSON.stringify({ url: "not-a-url" })));
    expect(badUrl.status).toBe(400);

    const unknownKey = await gifFetch(
      post("/gif/fetch", JSON.stringify({ url, extra: 1 })),
    );
    expect(unknownKey.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await gifFetch(post("/gif/fetch", JSON.stringify({ url })))).status).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("maps blocked URLs and unexpected failures", async () => {
    fetchGif.mockRejectedValueOnce(
      new GifProxyError("gif_url_blocked", "host not allowed", 400),
    );
    const blocked = await gifFetch(post("/gif/fetch", JSON.stringify({ url })));
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error.code).toBe("gif_url_blocked");

    fetchGif.mockRejectedValueOnce(new Error("boom"));
    const failed = await gifFetch(post("/gif/fetch", JSON.stringify({ url })));
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe("gif_provider_failed");
  });
});
