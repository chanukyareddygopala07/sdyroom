import { POST, SWEEP_GRACE_MS } from "@/app/api/resources/cleanup/route";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, requireRoomMembership } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  requireRoomMembership: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));

const USER = "user-1";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const OLD = new Date(Date.now() - SWEEP_GRACE_MS - 60_000).toISOString();
const YOUNG = new Date(Date.now() - 1_000).toISOString();

type Row = { id: string; storage_path: string; created_at: string };
type Entry = { name: string; id: string | null; created_at?: string };
type RpcResult = { data: unknown; error?: { message: string } };
type BuilderResult = { data: unknown; error?: { message: string } };

/**
 * A purpose-built fake for the sweep: one `from()` builder whose awaits
 * resolve from a queue (row list first, then the delete), plus a storage
 * bucket whose list/remove results each test sets directly.
 */
function fakeClient(options: {
  rpcResult?: RpcResult;
  rows?: Row[];
  rowListError?: string;
  listEntries?: Entry[];
  listError?: string;
  removeError?: string;
  deleteResult?: BuilderResult;
}) {
  const {
    rpcResult = { data: true },
    rows = [],
    rowListError,
    listEntries = [],
    listError,
    removeError,
    deleteResult = { data: [] },
  } = options;

  const calls = {
    rpc: [] as { fn: string; args: unknown }[],
    like: [] as string[],
    in: [] as unknown[][],
    list: [] as { prefix: string; options: unknown }[],
    remove: [] as string[][],
    from: 0,
  };

  const builderResults: BuilderResult[] = [
    rowListError
      ? { data: null, error: { message: rowListError } }
      : { data: rows },
    deleteResult,
  ];
  const builder = {
    select: vi.fn(() => builder),
    like: vi.fn((_column: string, pattern: string) => {
      calls.like.push(pattern);
      return builder;
    }),
    delete: vi.fn(() => builder),
    in: vi.fn((_column: string, values: unknown[]) => {
      calls.in.push(values);
      return builder;
    }),
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(builderResults.shift() ?? { data: [], error: null }).then(
        onFulfilled,
        onRejected,
      ),
  };

  const bucket = {
    list: vi.fn(async (prefix: string, listOptions: unknown) => {
      calls.list.push({ prefix, options: listOptions });
      return { data: listEntries, error: listError ? { message: listError } : null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      calls.remove.push(paths);
      return { data: paths, error: removeError ? { message: removeError } : null };
    }),
  };

  const client = {
    auth: { getClaims },
    rpc: vi.fn(async (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args });
      return rpcResult;
    }),
    from: vi.fn(() => {
      calls.from += 1;
      return builder;
    }),
    storage: { from: vi.fn(() => bucket) },
  };

  return { client, calls };
}

function cleanup(body?: string) {
  return new NextRequest("http://localhost:3000/api/resources/cleanup", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

describe("POST /api/resources/cleanup", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
    requireRoomMembership.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });
    const { client } = fakeClient({});

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup("{}"));

    expect(response.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("answers an over-ceiling caller with 429 before reading the body", async () => {
    const { client, calls } = fakeClient({ rpcResult: { data: false } });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup("not even close to json"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect((await response.json()).error.code).toBe("rate_limited");
    expect(calls.rpc[0]).toEqual({
      fn: "rate_limit_take",
      args: { p_key: `cleanup:user:${USER}`, p_max: 5, p_window: "60 seconds" },
    });
    expect(calls.from).toBe(0);
  });

  it("rejects a body that is not JSON with 400", async () => {
    const { client } = fakeClient({});

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup("{nope"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(client.from).not.toHaveBeenCalled();
  });

  it("rejects a non-object body with 400", async () => {
    const { client } = fakeClient({});

    createClient.mockResolvedValue(client);
    for (const body of ["5", "null", '"x"', "[]"]) {
      const response = await POST(cleanup(body));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    expect(client.from).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID with 400", async () => {
    const { client } = fakeClient({});

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup(JSON.stringify({ room_id: "nope" })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues).toEqual([
      { path: "room_id", message: expect.any(String) },
    ]);
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("sweeps the caller's personal folder: orphan object out, broken row out", async () => {
    const { client, calls } = fakeClient({
      rows: [
        { id: "row-1", storage_path: `personal/${USER}/broken.pdf`, created_at: OLD },
        { id: "row-2", storage_path: `personal/${USER}/alive.pdf`, created_at: OLD },
      ],
      listEntries: [
        { name: "alive.pdf", id: "obj-alive", created_at: OLD },
        { name: "orphan.pdf", id: "obj-orphan", created_at: OLD },
        { name: "just-uploaded.pdf", id: "obj-young", created_at: YOUNG },
        { name: "folder", id: null, created_at: OLD },
      ],
      deleteResult: { data: [{ id: "row-1" }] },
    });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed_objects: 1,
      removed_rows: 1,
      scope: "personal",
      room_id: null,
    });
    expect(calls.like).toEqual([`personal/${USER}/%`]);
    expect(calls.list[0].prefix).toBe(`personal/${USER}`);
    expect(calls.remove).toEqual([[`personal/${USER}/orphan.pdf`]]);
    expect(calls.in).toEqual([["row-1"]]);
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("never sweeps anything younger than the grace period", async () => {
    const { client, calls } = fakeClient({
      rows: [
        { id: "row-young", storage_path: `personal/${USER}/fresh.pdf`, created_at: YOUNG },
      ],
      listEntries: [{ name: "fresh.pdf", id: "obj-young", created_at: YOUNG }],
    });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed_objects: 0,
      removed_rows: 0,
      scope: "personal",
      room_id: null,
    });
    expect(calls.remove).toEqual([]);
    expect(calls.in).toEqual([]);
  });

  it("skips rows it cannot date rather than guessing", async () => {
    const { client, calls } = fakeClient({
      rows: [
        { id: "row-odd", storage_path: `personal/${USER}/odd.pdf`, created_at: "not-a-date" },
      ],
      listEntries: [],
    });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(200);
    expect(calls.in).toEqual([]);
  });

  it("sweeps a room scope under the caller's own key only", async () => {
    const { client, calls } = fakeClient({
      rows: [],
      listEntries: [{ name: "orphan.pdf", id: "obj-1", created_at: OLD }],
    });

    createClient.mockResolvedValue(client);
    const response = await POST(
      cleanup(JSON.stringify({ room_id: ROOM_ID })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed_objects: 1,
      removed_rows: 0,
      scope: "room",
      room_id: ROOM_ID,
    });
    expect(requireRoomMembership).toHaveBeenCalledWith(expect.anything(), ROOM_ID);
    expect(calls.like).toEqual([`rooms/${ROOM_ID}/${USER}/%`]);
    expect(calls.list[0].prefix).toBe(`rooms/${ROOM_ID}/${USER}`);
    expect(calls.remove).toEqual([[`rooms/${ROOM_ID}/${USER}/orphan.pdf`]]);
  });

  it("answers a non-member sweeping a room with the workspace's 404", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const { client, calls } = fakeClient({});

    createClient.mockResolvedValue(client);
    const response = await POST(
      cleanup(JSON.stringify({ room_id: ROOM_ID })),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(calls.from).toBe(0);
  });

  it("answers an unreadable row list with cleanup_failed", async () => {
    const { client } = fakeClient({ rowListError: "permission denied" });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("cleanup_failed");
  });

  it("answers an unreadable storage listing with cleanup_failed", async () => {
    const { client } = fakeClient({ listError: "bucket unavailable" });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("cleanup_failed");
  });

  it("answers a failed object removal with cleanup_failed", async () => {
    const { client } = fakeClient({
      rows: [],
      listEntries: [{ name: "orphan.pdf", id: "obj-1", created_at: OLD }],
      removeError: "row lock timeout",
    });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("cleanup_failed");
  });

  it("answers a failed row delete with cleanup_failed", async () => {
    const { client } = fakeClient({
      rows: [{ id: "row-1", storage_path: `personal/${USER}/broken.pdf`, created_at: OLD }],
      deleteResult: { data: null, error: { message: "update deadlock" } },
    });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("cleanup_failed");
  });

  it("returns a zero count when the scope is clean", async () => {
    const { client } = fakeClient({ rows: [], listEntries: [] });

    createClient.mockResolvedValue(client);
    const response = await POST(cleanup());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed_objects: 0,
      removed_rows: 0,
      scope: "personal",
      room_id: null,
    });
  });
});
