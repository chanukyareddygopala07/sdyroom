import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CommunityApiError,
  createAttachmentClient,
  createChannelClient,
  createCommunityClient,
  deleteCommunityClient,
  downloadAttachmentClient,
  gifFetchClient,
  gifSearchClient,
  getCommunityClient,
  joinCommunityClient,
  leaveCommunityClient,
  listChannelsClient,
  listCommunitiesClient,
  listMembersClient,
  listMessagesClient,
  listWelcomesClient,
  registerDeviceClient,
  removeMemberClient,
  reportClient,
  sendMessageClient,
  sendWelcomeClient,
  setMemberClient,
  syncClient,
  updateCommunityClient,
  uploadAttachmentBytes,
} from "@/lib/communities/api";

const COMMUNITY = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const CHANNEL = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";
const USER = "2d4e1b30-5f6a-4d7e-af81-9c0d1e2f3041";

type FetchCall = [string, RequestInit | undefined];
let fetchMock: ReturnType<typeof vi.fn>;
/** Every fetch invocation, including once-queued responses. */
const recorded = (): FetchCall[] => fetchMock.mock.calls as FetchCall[];

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request() error envelope handling", () => {
  it("maps the server envelope and retry-after onto CommunityApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { error: { code: "rate_limited", message: "Slow down." } },
        { status: 429, headers: { "retry-after": "42" } },
      ),
    );
    const error = await getCommunityClient(COMMUNITY).catch(
      (e: CommunityApiError) => e,
    );
    expect(error).toBeInstanceOf(CommunityApiError);
    expect(error).toMatchObject({
      code: "rate_limited",
      message: "Slow down.",
      status: 429,
      retryAfter: 42,
    });
  });

  it("falls back to request_failed when the body is not an envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>502</html>", { status: 502 }),
    );
    const error = await getCommunityClient(COMMUNITY).catch(
      (e: CommunityApiError) => e,
    );
    expect(error).toMatchObject({
      code: "request_failed",
      status: 502,
      retryAfter: null,
    });
  });

  it("treats 204 as an empty success", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteCommunityClient(COMMUNITY)).resolves.toBeUndefined();
    await expect(leaveCommunityClient(COMMUNITY)).resolves.toBeUndefined();
  });
});

describe("read fetchers", () => {
  it("builds discovery query strings from set params only", async () => {
    await listCommunitiesClient({ category: "exams", q: "jee", limit: 10 });
    expect(recorded()[0]![0]).toBe(
      "/api/communities?category=exams&q=jee&limit=10",
    );
    await listCommunitiesClient({});
    expect(recorded()[1]![0]).toBe("/api/communities");
  });

  it("hits the documented read endpoints", async () => {
    await getCommunityClient(COMMUNITY);
    await listMembersClient(COMMUNITY, { includeRequested: true });
    await listMembersClient(COMMUNITY);
    await listChannelsClient(COMMUNITY);
    await listWelcomesClient(COMMUNITY);
    await syncClient(COMMUNITY);
    expect(recorded().map(([url]) => url)).toEqual([
      `/api/communities/${COMMUNITY}`,
      `/api/communities/${COMMUNITY}/members?include_requested=1`,
      `/api/communities/${COMMUNITY}/members`,
      `/api/communities/${COMMUNITY}/channels`,
      `/api/communities/${COMMUNITY}/welcomes`,
      `/api/communities/${COMMUNITY}/sync`,
    ]);
    expect(recorded().every(([, init]) => init?.method === undefined)).toBe(true);
  });

  it("builds message page cursors", async () => {
    await listMessagesClient(COMMUNITY, CHANNEL, { before: 42, limit: 50 });
    await listMessagesClient(COMMUNITY, CHANNEL);
    expect(recorded()[0]![0]).toBe(
      `/api/communities/${COMMUNITY}/channels/${CHANNEL}/messages?before=42&limit=50`,
    );
    expect(recorded()[1]![0]).toBe(
      `/api/communities/${COMMUNITY}/channels/${CHANNEL}/messages`,
    );
  });

  it("encodes gif queries", async () => {
    await gifSearchClient("cat & dog");
    expect(recorded()[0]![0]).toBe(
      "/api/communities/gif/search?q=cat%20%26%20dog",
    );
  });
});

describe("write fetchers", () => {
  it("posts/patches/deletes with JSON bodies and content-type", async () => {
    await createCommunityClient({ slug: "study-hall", name: "Study Hall" });
    await updateCommunityClient(COMMUNITY, { name: "Renamed" });
    await joinCommunityClient(COMMUNITY);
    await setMemberClient(COMMUNITY, USER, { role: "moderator" });
    await removeMemberClient(COMMUNITY, USER);
    await createChannelClient(COMMUNITY, { name: "General", slug: "general" });
    await registerDeviceClient({
      deviceId: "device-12345678",
      keyPackage: "AAAA",
      signaturePublicKey: "BBBB",
    });
    await reportClient(COMMUNITY, {
      targetType: "message",
      targetId: "m1",
      reason: "spam",
    });

    const [createUrl, createInit] = recorded()[0]!;
    expect(createUrl).toBe("/api/communities");
    expect(createInit?.method).toBe("POST");
    expect(createInit?.headers).toMatchObject({
      "content-type": "application/json",
    });
    expect(JSON.parse(String(createInit?.body))).toEqual({
      slug: "study-hall",
      name: "Study Hall",
    });

    expect(recorded()[1]![1]).toMatchObject({ method: "PATCH" });
    expect(recorded()[2]![1]).toMatchObject({ method: "POST" });
    expect(recorded()[2]![0]).toBe(`/api/communities/${COMMUNITY}/join`);
    expect(recorded()[3]![1]).toMatchObject({ method: "PATCH" });
    expect(recorded()[4]![1]).toMatchObject({ method: "DELETE" });
    expect(recorded()[5]![1]).toMatchObject({ method: "POST" });
    expect(recorded()[6]![1]).toMatchObject({ method: "POST" });
    expect(recorded()[7]![1]).toMatchObject({ method: "POST" });
  });

  it("posts messages and welcomes to their channel endpoints", async () => {
    await sendMessageClient(COMMUNITY, CHANNEL, {
      kind: "application",
      ciphertext: "AAAA",
      clientMsgId: "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152",
      senderDeviceId: "device-12345678",
    });
    await sendWelcomeClient(COMMUNITY, CHANNEL, {
      ciphertext: "AAAA",
      ratchetTree: "BBBB",
      clientMsgId: "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152",
      recipientUserId: USER,
      recipientDeviceId: "device-87654321",
    });
    await createAttachmentClient(COMMUNITY, {
      channelId: CHANNEL,
      storagePath: `community-attachments/${COMMUNITY}/${CHANNEL}/x`,
      ciphertextSize: 10,
      contentType: "application/octet-stream",
    });

    expect(recorded()[0]![0]).toBe(
      `/api/communities/${COMMUNITY}/channels/${CHANNEL}/messages`,
    );
    expect(recorded()[1]![0]).toBe(
      `/api/communities/${COMMUNITY}/channels/${CHANNEL}/welcomes`,
    );
    expect(recorded()[2]![0]).toBe(`/api/communities/${COMMUNITY}/attachments`);
    for (const [, init] of recorded()) {
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
      });
    }
  });
});

describe("binary fetchers", () => {
  it("downloadAttachmentClient resolves the signed URL then fetches bytes", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ url: "https://storage.example.com/obj" }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );

    const bytes = await downloadAttachmentClient(COMMUNITY, "att-1");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(recorded()[1]![0]).toBe("https://storage.example.com/obj");
  });

  it("downloadAttachmentClient maps storage failures", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ url: "https://storage.example.com/obj" }))
      .mockResolvedValueOnce(new Response("nope", { status: 403 }));
    const error = await downloadAttachmentClient(COMMUNITY, "att-1").catch(
      (e: CommunityApiError) => e,
    );
    expect(error).toMatchObject({
      code: "attachment_download_failed",
      status: 403,
    });
  });

  it("uploadAttachmentBytes puts ciphertext into the private bucket", async () => {
    const upload = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = {
      storage: { from: vi.fn().mockReturnValue({ upload }) },
    } as unknown as SupabaseClient;

    await uploadAttachmentBytes(supabase, "community-attachments/a/b/c", new Uint8Array([9]));
    expect(supabase.storage.from).toHaveBeenCalledWith("community-attachments");
    expect(upload).toHaveBeenCalledWith(
      "community-attachments/a/b/c",
      expect.any(Uint8Array),
      { contentType: "application/octet-stream", upsert: false },
    );
  });

  it("uploadAttachmentBytes maps storage errors", async () => {
    const upload = vi.fn().mockResolvedValue({ data: null, error: { message: "denied" } });
    const supabase = {
      storage: { from: vi.fn().mockReturnValue({ upload }) },
    } as unknown as SupabaseClient;
    await expect(
      uploadAttachmentBytes(supabase, "p", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "attachment_upload_failed", status: 500 });
  });

  it("gifFetchClient returns bytes on success", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([7, 8]), { status: 200 }));
    const bytes = await gifFetchClient("https://media.tenor.com/x.gif");
    expect(Array.from(bytes)).toEqual([7, 8]);
    expect(recorded()[0]).toEqual([
      "/api/communities/gif/fetch",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ]);
  });

  it("gifFetchClient maps error envelopes and missing bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "gif_unavailable", message: "off" } }, { status: 503 }),
    );
    const withEnvelope = await gifFetchClient("u").catch((e: CommunityApiError) => e);
    expect(withEnvelope).toMatchObject({ code: "gif_unavailable", status: 503 });

    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    const withoutEnvelope = await gifFetchClient("u").catch((e: CommunityApiError) => e);
    expect(withoutEnvelope).toMatchObject({
      code: "gif_provider_failed",
      status: 500,
    });
  });
});
