import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  listActiveMemberIds,
  fetchCommunityKeyPackages,
  registerCommunityDevice,
  joinCommunity,
  leaveCommunity,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(async (): Promise<Response | null> => null),
  listActiveMemberIds: vi.fn(),
  fetchCommunityKeyPackages: vi.fn(),
  registerCommunityDevice: vi.fn(),
  joinCommunity: vi.fn(),
  leaveCommunity: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", () => ({ rateLimitedResponse }));
vi.mock("@/lib/communities/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/queries")>()),
  listActiveMemberIds,
  fetchCommunityKeyPackages,
  registerCommunityDevice,
  joinCommunity,
  leaveCommunity,
}));

import { GET as sync } from "@/app/api/communities/[id]/sync/route";
import { POST as registerDevice } from "@/app/api/communities/devices/route";
import { POST as fetchKeys } from "@/app/api/communities/devices/fetch/route";
import { POST as join } from "@/app/api/communities/[id]/join/route";
import { POST as leave } from "@/app/api/communities/[id]/leave/route";
import { CommunityError } from "@/lib/communities/queries";

const ID = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const USER = "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152";
const OTHER = "2d4e1b30-5f6a-4d7e-af81-9c0d1e2f3041";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };

function useDb(tables: Record<string, Result[]>) {
  const queues = new Map<string, Result[]>(
    Object.entries(tables).map(([table, results]) => [table, [...results]]),
  );
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
  };
  createClient.mockResolvedValue({ auth: { getClaims }, from: client.from });
  return client;
}

function ctx(id: string = ID) {
  return { params: Promise.resolve({ id }) };
}

function get(path: string) {
  return new NextRequest(`http://localhost:3000/api/communities${path}`);
}

function post(path: string, body?: BodyInit) {
  return new NextRequest(`http://localhost:3000/api/communities${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

const DEVICE = {
  deviceId: "device-12345678",
  keyPackage: "A".repeat(96),
  signaturePublicKey: "sig-public-key-1234567890",
};

const KEYS = {
  communityId: ID,
  userIds: [OTHER],
};

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  rateLimitedResponse.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/communities/[id]/sync", () => {
  it("returns active member ids and every key package for members", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    listActiveMemberIds.mockResolvedValue([USER, OTHER]);
    fetchCommunityKeyPackages.mockResolvedValue([{ user_id: OTHER }]);

    const response = await sync(get(`/${ID}/sync`), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      member_ids: [USER, OTHER],
      devices: [{ user_id: OTHER }],
    });
    expect(fetchCommunityKeyPackages).toHaveBeenCalledWith(
      expect.anything(),
      [USER, OTHER],
    );
  });

  it("covers auth/id/access gates and maps failures", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await sync(get(`/${ID}/sync`), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await sync(get(`/nope/sync`), ctx("nope"))).status).toBe(400);

    useDb({ community_members: [{ data: null, error: null }] });
    expect((await sync(get(`/${ID}/sync`), ctx())).status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    listActiveMemberIds.mockRejectedValueOnce(new Error("boom"));
    const failed = await sync(get(`/${ID}/sync`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("sync_failed");
  });
});

describe("POST /api/communities/devices", () => {
  it("registers the caller's public key package with no community gate", async () => {
    registerCommunityDevice.mockResolvedValue({ deviceId: DEVICE.deviceId });
    const response = await registerDevice(post("/devices", JSON.stringify(DEVICE)));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ device: { deviceId: DEVICE.deviceId } });
    expect(registerCommunityDevice).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      {
        deviceId: DEVICE.deviceId,
        keyPackage: DEVICE.keyPackage,
        signaturePublicKey: DEVICE.signaturePublicKey,
      },
    );
  });

  it("covers auth, body, schema and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await registerDevice(post("/devices", JSON.stringify(DEVICE)))).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await registerDevice(post("/devices", "oops"))).status).toBe(400);

    const shortKey = await registerDevice(
      post("/devices", JSON.stringify({ ...DEVICE, keyPackage: "AAA" })),
    );
    expect(shortKey.status).toBe(400);

    const unknownKey = await registerDevice(
      post("/devices", JSON.stringify({ ...DEVICE, extra: 1 })),
    );
    expect(unknownKey.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await registerDevice(post("/devices", JSON.stringify(DEVICE)))).status).toBe(429);
  });

  it("maps registration failures", async () => {
    registerCommunityDevice.mockRejectedValueOnce(
      new CommunityError("device_register_failed", "nope", 500),
    );
    const conflict = await registerDevice(post("/devices", JSON.stringify(DEVICE)));
    expect(conflict.status).toBe(500);
    expect((await conflict.json()).error.code).toBe("device_register_failed");

    registerCommunityDevice.mockRejectedValueOnce(new Error("boom"));
    const failed = await registerDevice(post("/devices", JSON.stringify(DEVICE)));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("device_register_failed");
  });
});

describe("POST /api/communities/devices/fetch", () => {
  it("returns key packages for the given users inside a community", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    fetchCommunityKeyPackages.mockResolvedValue([{ user_id: OTHER }]);

    const response = await fetchKeys(post("/devices/fetch", JSON.stringify(KEYS)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ devices: [{ user_id: OTHER }] });
    expect(fetchCommunityKeyPackages).toHaveBeenCalledWith(expect.anything(), [OTHER]);
  });

  it("covers auth, body, schema and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await fetchKeys(post("/devices/fetch", JSON.stringify(KEYS)))).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await fetchKeys(post("/devices/fetch", "oops"))).status).toBe(400);

    const empty = await fetchKeys(
      post("/devices/fetch", JSON.stringify({ communityId: ID, userIds: [] })),
    );
    expect(empty.status).toBe(400);

    const badCommunity = await fetchKeys(
      post("/devices/fetch", JSON.stringify({ communityId: "nope", userIds: [OTHER] })),
    );
    expect(badCommunity.status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await fetchKeys(post("/devices/fetch", JSON.stringify(KEYS)))).status).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("maps access failures and unexpected errors", async () => {
    useDb({ community_members: [{ data: null, error: null }] });
    expect((await fetchKeys(post("/devices/fetch", JSON.stringify(KEYS)))).status).toBe(404);

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    fetchCommunityKeyPackages.mockRejectedValueOnce(new Error("boom"));
    const failed = await fetchKeys(post("/devices/fetch", JSON.stringify(KEYS)));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("keys_fetch_failed");
  });
});

describe("POST /api/communities/[id]/join", () => {
  it("joins an open community or files a request", async () => {
    joinCommunity.mockResolvedValue("active");
    const active = await join(post(`/${ID}/join`), ctx());
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ status: "active" });

    joinCommunity.mockResolvedValueOnce("requested");
    const requested = await join(post(`/${ID}/join`), ctx());
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ status: "requested" });
  });

  it("covers auth, id and throttle gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await join(post(`/${ID}/join`), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await join(post(`/nope/join`), ctx("nope"))).status).toBe(400);

    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    expect((await join(post(`/${ID}/join`), ctx())).status).toBe(429);
    rateLimitedResponse.mockResolvedValue(null);
  });

  it("maps banned, missing and unexpected join failures", async () => {
    joinCommunity.mockRejectedValueOnce(new CommunityError("forbidden", "banned", 403));
    expect((await join(post(`/${ID}/join`), ctx())).status).toBe(403);

    joinCommunity.mockRejectedValueOnce(new CommunityError("not_found", "gone", 404));
    expect((await join(post(`/${ID}/join`), ctx())).status).toBe(404);

    joinCommunity.mockRejectedValueOnce(new Error("boom"));
    const failed = await join(post(`/${ID}/join`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("community_join_failed");
  });
});

describe("POST /api/communities/[id]/leave", () => {
  it("leaves with a 204", async () => {
    leaveCommunity.mockResolvedValue(undefined);
    const response = await leave(post(`/${ID}/leave`), ctx());
    expect(response.status).toBe(204);
    expect(leaveCommunity).toHaveBeenCalledWith(expect.anything(), ID);
  });

  it("covers auth/id gates and maps leave failures", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await leave(post(`/${ID}/leave`), ctx())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await leave(post(`/nope/leave`), ctx("nope"))).status).toBe(400);

    leaveCommunity.mockRejectedValueOnce(
      new CommunityError("owner_cannot_leave", "Transfer ownership first.", 409),
    );
    const conflict = await leave(post(`/${ID}/leave`), ctx());
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("owner_cannot_leave");

    leaveCommunity.mockRejectedValueOnce(new CommunityError("not_found", "gone", 404));
    expect((await leave(post(`/${ID}/leave`), ctx())).status).toBe(404);

    leaveCommunity.mockRejectedValueOnce(new Error("boom"));
    const failed = await leave(post(`/${ID}/leave`), ctx());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("community_leave_failed");
  });
});
