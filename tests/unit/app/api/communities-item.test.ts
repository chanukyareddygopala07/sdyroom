import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, getCommunity, updateCommunity } = vi.hoisted(
  () => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    getCommunity: vi.fn(),
    updateCommunity: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/communities/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communities/queries")>()),
  getCommunity,
  updateCommunity,
}));

import { DELETE, GET, PATCH } from "@/app/api/communities/[id]/route";
import { CommunityError } from "@/lib/communities/queries";

const ID = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const USER = "2d4e1b30-5f6a-4d7e-af81-9c0d1e2f3041";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };

/** Chainable fake; each `from()` consumes that table's next scripted result
 * in call order (matches how the route + real access helpers interleave). */
function makeDb(tables: Record<string, Result[]>) {
  const queues = new Map<string, Result[]>(
    Object.entries(tables).map(([table, results]) => [table, [...results]]),
  );
  const log: Array<{ table: string; method: string }> = [];
  const client = {
    from(table: string) {
      const take = (): Result => queues.get(table)?.shift() ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const method = (name: string) => (...args: unknown[]) => {
        void args;
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

function context(id: string = ID) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: BodyInit) {
  return new NextRequest(`http://localhost:3000/api/communities/${ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });
}

function useDb(tables: Record<string, Result[]>) {
  const db = makeDb(tables);
  createClient.mockResolvedValue({ auth: { getClaims }, from: db.client.from });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  createClient.mockResolvedValue({ auth: { getClaims } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/communities/[id]", () => {
  it("401s signed-out callers", async () => {
    getClaims.mockResolvedValue({ data: null });
    const response = await GET(new NextRequest(`http://localhost:3000/api/communities/${ID}`), context());
    expect(response.status).toBe(401);
    expect(getCommunity).not.toHaveBeenCalled();
  });

  it("400s a non-uuid id without touching the database", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/api/communities/nope"),
      context("nope"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("serves a public community to a visitor with membership null", async () => {
    const db = useDb({
      communities: [{ data: { visibility: "public" } }],
      community_members: [
        { data: null, error: null }, // visibility role probe
        { data: null, error: null }, // route membership lookup
      ],
    });
    getCommunity.mockResolvedValue({ id: ID, visibility: "public" });

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/communities/${ID}`),
      context(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      community: { id: ID, visibility: "public" },
      membership: null,
      visibility: "public",
    });
    expect(db.log[0]).toEqual({ table: "communities", method: "select" });
  });

  it("includes the caller's active membership on a private community", async () => {
    useDb({
      communities: [{ data: { visibility: "private" } }],
      community_members: [
        { data: { role: "member", status: "active" } }, // visibility gate
        { data: { role: "moderator", status: "active", joined_at: "t1" } },
      ],
    });
    getCommunity.mockResolvedValue({ id: ID, visibility: "private" });

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/communities/${ID}`),
      context(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.membership).toEqual({
      role: "moderator",
      status: "active",
      joined_at: "t1",
    });
    expect(body.visibility).toBe("private");
  });

  it("returns a non-active membership row as-is (join state, not access)", async () => {
    useDb({
      communities: [{ data: { visibility: "public" } }],
      community_members: [
        { data: null, error: null },
        { data: { role: "member", status: "requested", joined_at: "t2" } },
      ],
    });
    getCommunity.mockResolvedValue({ id: ID });

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/communities/${ID}`),
      context(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).membership).toEqual({
      role: "member",
      status: "requested",
      joined_at: "t2",
    });
  });

  it("maps private/unknown communities to 404 and failures to 500", async () => {
    useDb({
      communities: [{ data: { visibility: "private" } }],
      community_members: [{ data: null, error: null }],
    });
    const hidden = await GET(
      new NextRequest(`http://localhost:3000/api/communities/${ID}`),
      context(),
    );
    expect(hidden.status).toBe(404);
    expect((await hidden.json()).error.code).toBe("not_found");

    useDb({ communities: [{ data: { visibility: "public" } }], community_members: [{ data: null, error: null }] });
    getCommunity.mockRejectedValueOnce(new CommunityError("not_found", "gone", 404));
    const gone = await GET(
      new NextRequest(`http://localhost:3000/api/communities/${ID}`),
      context(),
    );
    expect(gone.status).toBe(404);

    useDb({ communities: [{ data: { visibility: "public" } }], community_members: [{ data: null, error: null }] });
    getCommunity.mockRejectedValueOnce(new Error("boom"));
    const failed = await GET(
      new NextRequest(`http://localhost:3000/api/communities/${ID}`),
      context(),
    );
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("community_failed");
  });
});

describe("PATCH /api/communities/[id]", () => {
  it("covers auth, id, body and schema gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await PATCH(patchRequest("{}"), context())).status).toBe(401);

    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await PATCH(patchRequest("{}"), context("nope"))).status).toBe(400);

    const badJson = await PATCH(patchRequest("oops"), context());
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error.code).toBe("invalid_json");

    const unknownKey = await PATCH(patchRequest(JSON.stringify({ owner_id: USER })), context());
    expect(unknownKey.status).toBe(400);
    expect((await unknownKey.json()).error.code).toBe("validation");
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("applies the patch for staff", async () => {
    useDb({
      community_members: [{ data: { role: "moderator", status: "active" } }],
    });
    updateCommunity.mockResolvedValue({ id: ID, name: "Renamed" });

    const response = await PATCH(
      patchRequest(JSON.stringify({ name: "Renamed" })),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      community: { id: ID, name: "Renamed" },
    });
    expect(updateCommunity).toHaveBeenCalledWith(expect.anything(), ID, {
      name: "Renamed",
      description: "",
      rules: "",
    });
  });

  it("rejects pairing private visibility with open joining at the schema", async () => {
    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
    });
    const response = await PATCH(
      patchRequest(JSON.stringify({ visibility: "private", joinPolicy: "open" })),
      context(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(updateCommunity).not.toHaveBeenCalled();
  });

  it("reads the current policy when only visibility changes", async () => {
    useDb({
      community_members: [
        { data: { role: "owner", status: "active" } },
        { data: { role: "owner", status: "active" } },
      ],
    });
    updateCommunity.mockResolvedValue({ id: ID });
    getCommunity.mockResolvedValue({ id: ID, join_policy: "open" });

    await PATCH(patchRequest(JSON.stringify({ visibility: "private" })), context());
    expect(updateCommunity).toHaveBeenCalledWith(expect.anything(), ID, {
      visibility: "private",
      description: "",
      rules: "",
      join_policy: "request",
    });

    getCommunity.mockResolvedValue({ id: ID, join_policy: "request" });
    await PATCH(patchRequest(JSON.stringify({ visibility: "private" })), context());
    expect(updateCommunity).toHaveBeenLastCalledWith(expect.anything(), ID, {
      visibility: "private",
      description: "",
      rules: "",
    });
    expect(updateCommunity).toHaveBeenCalledTimes(2);
  });

  it("maps staff/lookup/conflict/failure errors", async () => {
    useDb({
      community_members: [{ data: { role: "member", status: "active" } }],
    });
    const forbidden = await PATCH(patchRequest(JSON.stringify({ name: "Renamed" })), context());
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("forbidden");

    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
    });
    updateCommunity.mockRejectedValueOnce(
      new CommunityError("slug_taken", "taken", 409),
    );
    const conflict = await PATCH(patchRequest(JSON.stringify({ name: "Renamed" })), context());
    expect(conflict.status).toBe(409);

    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
    });
    updateCommunity.mockRejectedValueOnce(new Error("boom"));
    const failed = await PATCH(patchRequest(JSON.stringify({ name: "Renamed" })), context());
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("community_update_failed");
  });
});

describe("DELETE /api/communities/[id]", () => {
  function deleteRequest() {
    return new NextRequest(`http://localhost:3000/api/communities/${ID}`, {
      method: "DELETE",
    });
  }

  it("covers auth and id gates", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect((await DELETE(deleteRequest(), context())).status).toBe(401);
    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    expect((await DELETE(deleteRequest(), context("nope"))).status).toBe(400);
  });

  it("answers non-members with 404 (not a role error)", async () => {
    useDb({ community_members: [{ data: null, error: null }] });
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("204s when the owner's delete succeeds", async () => {
    useDb({
      community_members: [{ data: { role: "owner", status: "active" } }],
      communities: [{ data: [{ id: ID }], error: null }],
    });
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(204);
  });

  it("blocks a non-owner member whose RLS-filtered delete removed nothing", async () => {
    useDb({
      community_members: [
        { data: { role: "moderator", status: "active" } }, // access gate
        { data: { role: "moderator" } }, // role probe after the empty delete
      ],
      // PostgREST reports a policy-filtered DELETE as success over zero rows.
      communities: [{ data: [], error: null }],
    });
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("surfaces an owner-confirmed delete failure as 500", async () => {
    useDb({
      community_members: [
        { data: { role: "owner", status: "active" } },
        { data: { role: "owner" } },
      ],
      communities: [{ data: null, error: { message: "db down" } }],
    });
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("community_delete_failed");
  });

  it("fails loudly when an owner's delete unexpectedly removes no row", async () => {
    useDb({
      community_members: [
        { data: { role: "owner", status: "active" } },
        { data: { role: "owner" } },
      ],
      communities: [{ data: [], error: null }],
    });
    const response = await DELETE(deleteRequest(), context());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("community_delete_failed");
  });
});
