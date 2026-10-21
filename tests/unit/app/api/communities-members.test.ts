import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  listCommunityMembers,
  setCommunityMember,
  leaveCommunity,
  kickCommunityMember,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(async (): Promise<Response | null> => null),
  listCommunityMembers: vi.fn(),
  setCommunityMember: vi.fn(),
  leaveCommunity: vi.fn(),
  kickCommunityMember: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", () => ({ rateLimitedResponse }));
vi.mock("@/lib/communities/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/queries")>()),
  listCommunityMembers,
  setCommunityMember,
  leaveCommunity,
  kickCommunityMember,
}));

import { GET } from "@/app/api/communities/[id]/members/route";
import { PATCH, DELETE } from "@/app/api/communities/[id]/members/[userId]/route";
import { CommunityError } from "@/lib/communities/queries";

const ID = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const OTHER = "2d4e1b30-5f6a-4d7e-af81-9c0d1e2f3041";
const USER = "3e5f2c41-6a7b-4e8f-b092-0d1e2f304152";

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
      for (const name of ["select", "eq", "order", "limit", "insert", "update", "delete"]) {
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

function rosterContext(id: string = ID) {
  return { params: Promise.resolve({ id }) };
}
function memberContext(userId: string = OTHER, id: string = ID) {
  return { params: Promise.resolve({ id, userId }) };
}

function rosterRequest(query = "") {
  return new NextRequest(`http://localhost:3000/api/communities/${ID}/members${query}`);
}

function patchRequest(body: BodyInit, userId: string = OTHER) {
  return new NextRequest(
    `http://localhost:3000/api/communities/${ID}/members/${userId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    },
  );
}

function deleteRequest(userId: string = OTHER) {
  return new NextRequest(
    `http://localhost:3000/api/communities/${ID}/members/${userId}`,
    { method: "DELETE" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  rateLimitedResponse.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/communities/[id]/members", () => {
  it("lists the active roster for members", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    listCommunityMembers.mockResolvedValue([{ user_id: OTHER, alias: "Ada" }]);

    const response = await GET(rosterRequest(), rosterContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      members: [{ user_id: OTHER, alias: "Ada" }],
    });
    expect(listCommunityMembers).toHaveBeenCalledWith(expect.anything(), ID, {
      includeRequested: false,
    });
  });

  it("lets staff see pending requests but not plain members", async () => {
    useDb({ community_members: [{ data: { role: "moderator", status: "active" } }] });
    listCommunityMembers.mockResolvedValue([]);
    const staff = await GET(rosterRequest("?include_requested=1"), rosterContext());
    expect(staff.status).toBe(200);
    expect(listCommunityMembers).toHaveBeenCalledWith(expect.anything(), ID, {
      includeRequested: true,
    });

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    const member = await GET(rosterRequest("?include_requested=1"), rosterContext());
    expect(member.status).toBe(403);
    expect((await member.json()).error.code).toBe("forbidden");
  });

  it("covers auth/id gates and maps failures", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await GET(rosterRequest(), rosterContext())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await GET(rosterRequest(), rosterContext("nope"))).status).toBe(400);

    useDb({ community_members: [{ data: null, error: null }] });
    const hidden = await GET(rosterRequest(), rosterContext());
    expect(hidden.status).toBe(404);

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    listCommunityMembers.mockRejectedValueOnce(new Error("boom"));
    const failed = await GET(rosterRequest(), rosterContext());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("members_failed");
  });
});

describe("PATCH /api/communities/[id]/members/[userId]", () => {
  const body = { status: "active" };

  it("covers auth, ids, body and schema gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await PATCH(patchRequest(JSON.stringify(body)), memberContext())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await PATCH(patchRequest(JSON.stringify(body)), memberContext(OTHER, "nope"))).status).toBe(400);

    const badJson = await PATCH(patchRequest("oops"), memberContext());
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error.code).toBe("invalid_json");

    const unknown = await PATCH(
      patchRequest(JSON.stringify({ status: "active", extra: 1 })),
      memberContext(),
    );
    expect(unknown.status).toBe(400);

    const empty = await PATCH(patchRequest(JSON.stringify({})), memberContext());
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.message).toMatch(/role or a status/);
    expect(setCommunityMember).not.toHaveBeenCalled();
  });

  it("returns the rate-limit response when throttled", async () => {
    rateLimitedResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
    );
    const response = await PATCH(patchRequest(JSON.stringify(body)), memberContext());
    expect(response.status).toBe(429);
  });

  it("applies staff updates and maps RPC guards", async () => {
    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    setCommunityMember.mockResolvedValue(undefined);
    const ok = await PATCH(patchRequest(JSON.stringify({ role: "moderator" })), memberContext());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(setCommunityMember).toHaveBeenCalledWith(expect.anything(), ID, OTHER, {
      role: "moderator",
      status: null,
    });

    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    const forbidden = await PATCH(patchRequest(JSON.stringify(body)), memberContext());
    expect(forbidden.status).toBe(403);

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    setCommunityMember.mockRejectedValueOnce(
      new CommunityError("owner_protected", "protected", 409),
    );
    const conflict = await PATCH(patchRequest(JSON.stringify(body)), memberContext());
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("owner_protected");

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    setCommunityMember.mockRejectedValueOnce(new Error("boom"));
    const failed = await PATCH(patchRequest(JSON.stringify(body)), memberContext());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("member_update_failed");
  });
});

describe("DELETE /api/communities/[id]/members/[userId]", () => {
  it("runs self-removal through the leave RPC (member count stays honest)", async () => {
    leaveCommunity.mockResolvedValue(undefined);
    const response = await DELETE(deleteRequest(USER), memberContext(USER));
    expect(response.status).toBe(204);
    expect(leaveCommunity).toHaveBeenCalledWith(expect.anything(), ID);
    expect(setCommunityMember).not.toHaveBeenCalled();
    expect(kickCommunityMember).not.toHaveBeenCalled();
  });

  it("maps leave failures for the self path", async () => {
    leaveCommunity.mockRejectedValue(
      new CommunityError("owner_cannot_leave", "owner", 409),
    );
    const response = await DELETE(deleteRequest(USER), memberContext(USER));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("owner_cannot_leave");
  });

  it("covers auth and id gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await DELETE(deleteRequest(), memberContext())).status).toBe(401);
    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await DELETE(deleteRequest(), memberContext(OTHER, "nope"))).status).toBe(400);
  });

  it("kicks another member through the definer RPC", async () => {
    useDb({ community_members: [{ data: { role: "moderator", status: "active" } }] });
    kickCommunityMember.mockResolvedValue(undefined);

    const response = await DELETE(deleteRequest(), memberContext());
    expect(response.status).toBe(204);
    expect(kickCommunityMember).toHaveBeenCalledWith(expect.anything(), ID, OTHER);
    expect(setCommunityMember).not.toHaveBeenCalled();
  });

  it("refuses plain members before the RPC and maps the RPC's own guards", async () => {
    useDb({ community_members: [{ data: { role: "member", status: "active" } }] });
    const forbidden = await DELETE(deleteRequest(), memberContext());
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("forbidden");
    expect(kickCommunityMember).not.toHaveBeenCalled();

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    kickCommunityMember.mockRejectedValueOnce(
      new CommunityError("not_found", "That member does not exist in this community.", 404),
    );
    const missing = await DELETE(deleteRequest(), memberContext());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    kickCommunityMember.mockRejectedValueOnce(
      new CommunityError("owner_protected", "The owner cannot be removed.", 409),
    );
    const owner = await DELETE(deleteRequest(), memberContext());
    expect(owner.status).toBe(409);
    expect((await owner.json()).error.code).toBe("owner_protected");

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    kickCommunityMember.mockRejectedValueOnce(
      new CommunityError("forbidden", "Only community owners and moderators can do that.", 403),
    );
    const demoted = await DELETE(deleteRequest(), memberContext());
    expect(demoted.status).toBe(403);

    useDb({ community_members: [{ data: { role: "owner", status: "active" } }] });
    kickCommunityMember.mockRejectedValueOnce(new Error("boom"));
    const failed = await DELETE(deleteRequest(), memberContext());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("member_remove_failed");
  });
});
