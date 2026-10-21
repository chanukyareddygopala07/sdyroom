import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  listCommunityChannels,
  getCommunityChannel,
  listCommunityMessages,
  appendCommunityMessage,
  listPendingWelcomes,
  appendCommunityWelcome,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(async (): Promise<Response | null> => null),
  listCommunityChannels: vi.fn(),
  getCommunityChannel: vi.fn(),
  listCommunityMessages: vi.fn(),
  appendCommunityMessage: vi.fn(),
  listPendingWelcomes: vi.fn(),
  appendCommunityWelcome: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", () => ({ rateLimitedResponse }));
vi.mock("@/lib/communities/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/queries")>()),
  listCommunityChannels,
  getCommunityChannel,
  listCommunityMessages,
  appendCommunityMessage,
  listPendingWelcomes,
  appendCommunityWelcome,
}));

import { GET as listChannels, POST as createChannel } from "@/app/api/communities/[id]/channels/route";
import { GET as listMessages, POST as sendMessage } from "@/app/api/communities/[id]/channels/[channelId]/messages/route";
import { POST as sendWelcome } from "@/app/api/communities/[id]/channels/[channelId]/welcomes/route";
import { GET as listWelcomes } from "@/app/api/communities/[id]/welcomes/route";
import { CommunityError } from "@/lib/communities/queries";

const ID = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const CHANNEL = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";
const USER = "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152";
const MSG_ID = "4f6a3d52-7b8c-4f9a-a103-1e2f30415263";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };

function makeDb(tables: Record<string, Result[]>) {
  const queues = new Map<string, Result[]>(
    Object.entries(tables).map(([table, results]) => [table, [...results]]),
  );
  const log: Array<{ table: string; method: string }> = [];
  const client = {
    from(table: string) {
      const take = (): Result => queues.get(table)?.shift() ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const method = (name: string) => () => {
        log.push({ table, method: name });
        return chain;
      };
      for (const name of ["select", "eq", "order", "limit", "insert", "update", "delete", "lt"]) {
        chain[name] = method(name);
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
  };
  return { client, log };
}

function useDb(tables: Record<string, Result[]>) {
  const db = makeDb(tables);
  createClient.mockResolvedValue({ auth: { getClaims }, from: db.client.from });
  return db;
}

function ctx(id: string = ID, channelId: string = CHANNEL) {
  return { params: Promise.resolve({ id, channelId }) };
}

function url(path: string, query = "") {
  return new NextRequest(`http://localhost:3000/api/communities${path}${query}`);
}

function post(path: string, body: BodyInit) {
  return new NextRequest(`http://localhost:3000/api/communities${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const ENVELOPE = {
  kind: "application",
  ciphertext: "A".repeat(64),
  clientMsgId: MSG_ID,
  senderDeviceId: "device-12345678",
};

const WELCOME = {
  ciphertext: "A".repeat(64),
  ratchetTree: "B".repeat(64),
  clientMsgId: MSG_ID,
  recipientUserId: USER,
  recipientDeviceId: "device-87654321",
};

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  rateLimitedResponse.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/communities/[id]/channels", () => {
  it("lists channels for an active member and gates auth/id/outside", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    listCommunityChannels.mockResolvedValue([{ id: CHANNEL, slug: "general" }]);
    const ok = await listChannels(url(`/${ID}/channels`), ctx());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ channels: [{ id: CHANNEL, slug: "general" }] });

    getClaims.mockResolvedValue({ data: null });
    expect((await listChannels(url(`/${ID}/channels`), ctx())).status).toBe(401);
    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await listChannels(url(`/nope/channels`), ctx("nope"))).status).toBe(400);

    useDb({ community_members: [{ data: null, error: null }] });
    const hidden = await listChannels(url(`/${ID}/channels`), ctx());
    expect(hidden.status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    listCommunityChannels.mockRejectedValueOnce(new Error("boom"));
    const failed = await listChannels(url(`/${ID}/channels`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("channels_failed");
  });
});

describe("POST /api/communities/[id]/channels", () => {
  const body = { name: "Homework", slug: "homework" };

  it("covers auth, id, body, schema and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await createChannel(post(`/nope/channels`, JSON.stringify(body)), ctx("nope"))).status).toBe(400);

    const badJson = await createChannel(post(`/${ID}/channels`, "oops"), ctx());
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error.code).toBe("invalid_json");

    const badSchema = await createChannel(
      post(`/${ID}/channels`, JSON.stringify({ name: "H", slug: "Homework" })),
      ctx(),
    );
    expect(badSchema.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx())).status).toBe(429);
  });

  it("creates the next-position channel for staff", async () => {
    useDb({
      community_members: [{ data: { role: "moderator", status: "active" } }],
      community_channels: [
        { data: null, error: null }, // slug clash probe
        { data: { position: 3 } }, // max position
        { data: { id: CHANNEL, position: 4, slug: "homework" } }, // insert
      ],
    });
    const response = await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      channel: { id: CHANNEL, position: 4, slug: "homework" },
    });
  });

  it("defaults position to 1 when the community has no channels yet", async () => {
    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
      community_channels: [
        { data: null, error: null },
        { data: null, error: null },
        { data: { id: CHANNEL, position: 1 } },
      ],
    });
    const response = await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx());
    expect(response.status).toBe(201);
    expect((await response.json()).channel.position).toBe(1);
  });

  it("maps duplicate slugs, staff failures and unexpected errors", async () => {
    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
      community_channels: [{ data: { id: CHANNEL } }],
    });
    const clash = await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx());
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("channel_exists");

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    const forbidden = await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx());
    expect(forbidden.status).toBe(403);

    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
      community_channels: [
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: { message: "insert failed" } },
      ],
    });
    const conflict = await createChannel(post(`/${ID}/channels`, JSON.stringify(body)), ctx());
    expect(conflict.status).toBe(500);
    expect((await conflict.json()).error.code).toBe("channel_create_failed");

  });
});

describe("GET .../messages", () => {
  it("returns one ciphertext page for members", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    listCommunityMessages.mockResolvedValue({ messages: [], has_more: false });

    const response = await listMessages(
      url(`/${ID}/channels/${CHANNEL}/messages`, "?limit=10"),
      ctx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [], has_more: false });
    expect(listCommunityMessages).toHaveBeenCalledWith(expect.anything(), CHANNEL, {
      before: undefined,
      limit: 10,
    });
  });

  it("covers auth, id, query and access gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await listMessages(url(`/${ID}/channels/${CHANNEL}/messages`), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect(
      (await listMessages(url(`/nope/channels/${CHANNEL}/messages`), ctx("nope"))).status,
    ).toBe(400);
    expect(
      (await listMessages(url(`/${ID}/channels/nope/messages`), ctx(ID, "nope"))).status,
    ).toBe(400);
    expect(
      (await listMessages(url(`/${ID}/channels/${CHANNEL}/messages`, "?limit=0"), ctx())).status,
    ).toBe(400);

    useDb({ community_members: [{ data: null, error: null }] });
    const hidden = await listMessages(url(`/${ID}/channels/${CHANNEL}/messages`), ctx());
    expect(hidden.status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockRejectedValueOnce(
      new CommunityError("not_found", "That channel does not exist.", 404),
    );
    const gone = await listMessages(url(`/${ID}/channels/${CHANNEL}/messages`), ctx());
    expect(gone.status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValueOnce({ id: CHANNEL });
    listCommunityMessages.mockRejectedValueOnce(new Error("boom"));
    const failed = await listMessages(url(`/${ID}/channels/${CHANNEL}/messages`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("messages_failed");
  });
});

describe("POST .../messages", () => {
  it("stores one validated envelope as an active member", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    appendCommunityMessage.mockResolvedValue({ id: MSG_ID, seq: 1 });

    const response = await sendMessage(
      post(`/${ID}/channels/${CHANNEL}/messages`, JSON.stringify(ENVELOPE)),
      ctx(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ message: { id: MSG_ID, seq: 1 } });
    expect(appendCommunityMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: CHANNEL,
        communityId: ID,
        senderId: USER,
        kind: "application",
        clientMsgId: MSG_ID,
      }),
    );
  });

  it("covers gates and maps append failures", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect(
      (await sendMessage(post(`/${ID}/channels/${CHANNEL}/messages`, JSON.stringify(ENVELOPE)), ctx())).status,
    ).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    const badEnvelope = await sendMessage(
      post(`/${ID}/channels/${CHANNEL}/messages`, JSON.stringify({ ...ENVELOPE, ciphertext: "AA" })),
      ctx(),
    );
    expect(badEnvelope.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect(
      (await sendMessage(post(`/${ID}/channels/${CHANNEL}/messages`, JSON.stringify(ENVELOPE)), ctx())).status,
    ).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    appendCommunityMessage.mockRejectedValueOnce(
      new CommunityError("message_create_failed", "nope", 500),
    );
    const failed = await sendMessage(
      post(`/${ID}/channels/${CHANNEL}/messages`, JSON.stringify(ENVELOPE)),
      ctx(),
    );
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("message_create_failed");
  });
});

describe("welcomes routes", () => {
  it("POST stores an addressed welcome for members", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    appendCommunityWelcome.mockResolvedValue({ id: "w1" });

    const response = await sendWelcome(
      post(`/${ID}/channels/${CHANNEL}/welcomes`, JSON.stringify(WELCOME)),
      ctx(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ welcome: { id: "w1" } });
    expect(appendCommunityWelcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipientUserId: USER, ratchetTree: "B".repeat(64) }),
    );
  });

  it("POST covers gates and maps failures", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect(
      (await sendWelcome(post(`/${ID}/channels/${CHANNEL}/welcomes`, JSON.stringify(WELCOME)), ctx())).status,
    ).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    const badTree = await sendWelcome(
      post(`/${ID}/channels/${CHANNEL}/welcomes`, JSON.stringify({ ...WELCOME, ratchetTree: "no base64!!" })),
      ctx(),
    );
    expect(badTree.status).toBe(400);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    getCommunityChannel.mockResolvedValue({ id: CHANNEL });
    appendCommunityWelcome.mockRejectedValueOnce(new Error("boom"));
    const failed = await sendWelcome(
      post(`/${ID}/channels/${CHANNEL}/welcomes`, JSON.stringify(WELCOME)),
      ctx(),
    );
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("welcome_create_failed");
  });

  it("GET returns pending welcomes scoped to the community's channels", async () => {
    useDb({
      community_members: [{ data: { role: "member", status: "active" } }],
      community_channels: [{ data: [{ id: CHANNEL }] }],
    });
    listPendingWelcomes.mockResolvedValue([{ id: "w1" }]);

    const response = await listWelcomes(url(`/${ID}/welcomes`), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ welcomes: [{ id: "w1" }] });
    expect(listPendingWelcomes).toHaveBeenCalledWith(expect.anything(), USER, {
      channelIds: [CHANNEL],
    });
  });

  it("GET short-circuits to an empty list when the community has no channels", async () => {
    useDb({
      community_members: [{ data: { role: "member", status: "active" } }],
      community_channels: [{ data: [] }],
    });
    const response = await listWelcomes(url(`/${ID}/welcomes`), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ welcomes: [] });
    expect(listPendingWelcomes).not.toHaveBeenCalled();
  });

  it("GET maps access failures to 404 and unexpected ones to 500", async () => {
    useDb({ community_members: [{ data: null, error: null }] });
    const hidden = await listWelcomes(url(`/${ID}/welcomes`), ctx());
    expect(hidden.status).toBe(404);

    useDb({
      community_members: [{ data: { role: "member", status: "active" } }],
      community_channels: [{ data: [{ id: CHANNEL }] }],
    });
    listPendingWelcomes.mockRejectedValueOnce(new Error("boom"));
    const failed = await listWelcomes(url(`/${ID}/welcomes`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("welcomes_failed");
  });
});
