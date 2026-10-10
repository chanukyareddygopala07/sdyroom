import { DELETE } from "@/app/api/resources/[id]/route";
import { ResourceError } from "@/lib/resources/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  findResourceLocator,
  deleteResourceMetadata,
  removeResourceObject,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  findResourceLocator: vi.fn(),
  deleteResourceMetadata: vi.fn(),
  removeResourceObject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/resources/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/queries")>()),
  findResourceLocator,
  deleteResourceMetadata,
}));
vi.mock("@/lib/resources/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/storage")>()),
  removeResourceObject,
}));

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESOURCE = "44444444-4444-4444-8444-444444444444";
const ROOM = "11111111-1111-4111-8111-111111111111";

type RpcResult = {
  data: unknown;
  error?: { message: string } | null;
};

const rpc = vi.fn(
  async (...args: unknown[]): Promise<RpcResult> => {
    void args;
    return { data: true, error: null };
  },
);

function remove(id: string = RESOURCE) {
  return {
    request: new NextRequest(`http://localhost:3000/api/resources/${id}`, {
      method: "DELETE",
    }),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("DELETE /api/resources/[id]", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: true });
    getClaims.mockResolvedValue({ data: { claims: { sub: OWNER } } });
    createClient.mockResolvedValue({ auth: { getClaims }, rpc });
    findResourceLocator.mockResolvedValue({
      id: RESOURCE,
      room_id: null,
      storage_path: `personal/${OWNER}/${RESOURCE}.pdf`,
    });
    removeResourceObject.mockResolvedValue(undefined);
    deleteResourceMetadata.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(401);
    expect(findResourceLocator).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a UUID", async () => {
    const { request, context } = remove("nope");

    const response = await DELETE(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    expect(findResourceLocator).not.toHaveBeenCalled();
  });

  it("answers an over-ceiling caller with 429 before touching the row", async () => {
    rpc.mockResolvedValueOnce({ data: false });

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect((await response.json()).error.code).toBe("rate_limited");
    expect(rpc).toHaveBeenCalledWith("rate_limit_take", {
      p_key: `resource_delete:user:${OWNER}`,
      p_max: 30,
      p_window: "60 seconds",
    });
    expect(findResourceLocator).not.toHaveBeenCalled();
    expect(removeResourceObject).not.toHaveBeenCalled();
    expect(deleteResourceMetadata).not.toHaveBeenCalled();
  });

  it("answers 404 when RLS hides the row", async () => {
    findResourceLocator.mockResolvedValue(null);

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(removeResourceObject).not.toHaveBeenCalled();
    expect(deleteResourceMetadata).not.toHaveBeenCalled();
  });

  it("never touches storage for a file the caller did not upload", async () => {
    findResourceLocator.mockResolvedValue({
      id: RESOURCE,
      room_id: null,
      storage_path: `personal/${OTHER}/${RESOURCE}.pdf`,
    });

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect(removeResourceObject).not.toHaveBeenCalled();
    expect(deleteResourceMetadata).not.toHaveBeenCalled();
  });

  it("removes the object before the row and reports success", async () => {
    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(removeResourceObject).toHaveBeenCalledWith(
      expect.anything(),
      `personal/${OWNER}/${RESOURCE}.pdf`,
    );
    expect(removeResourceObject.mock.invocationCallOrder[0]).toBeLessThan(
      deleteResourceMetadata.mock.invocationCallOrder[0],
    );
    expect(deleteResourceMetadata).toHaveBeenCalledWith(expect.anything(), RESOURCE);
  });

  it("answers 404 when the row disappeared between lookup and delete", async () => {
    deleteResourceMetadata.mockResolvedValue(false);

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("maps a storage failure to cleanup_failed", async () => {
    removeResourceObject.mockRejectedValue(
      new ResourceError("cleanup_failed", "The file could not be removed. Please try again.", 500),
    );

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("cleanup_failed");
    expect(deleteResourceMetadata).not.toHaveBeenCalled();
  });

  it("returns 500 without leaking the database error", async () => {
    deleteResourceMetadata.mockRejectedValue(
      new Error("permission denied for table study_resources"),
    );

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("delete_failed");
    expect(JSON.stringify(body)).not.toContain("study_resources");
  });
  it.each(["owner", "moderator"] as const)(
  "allows a room %s to delete another member's shared upload",
  async (role) => {
    findResourceLocator.mockResolvedValue({
      id: RESOURCE,
      room_id: ROOM,
      storage_path: `rooms/${ROOM}/${OTHER}/${RESOURCE}.pdf`,
    });

    rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: role, error: null })
      .mockResolvedValueOnce({
        data: { code: "deleted", id: RESOURCE },
        error: null,
      });

    const { request, context } = remove();
    const response = await DELETE(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });

    expect(rpc).toHaveBeenNthCalledWith(2, "moderation_actor_role", {
      p_room_id: ROOM,
    });

    expect(rpc).toHaveBeenNthCalledWith(3, "delete_moderated_resource", {
      p_resource_id: RESOURCE,
    });

    expect(removeResourceObject).toHaveBeenCalledWith(
      expect.anything(),
      `rooms/${ROOM}/${OTHER}/${RESOURCE}.pdf`,
    );

    expect(deleteResourceMetadata).not.toHaveBeenCalled();
  },
);

it("denies an ordinary member deleting another member's shared upload", async () => {
  findResourceLocator.mockResolvedValue({
    id: RESOURCE,
    room_id: ROOM,
    storage_path: `rooms/${ROOM}/${OTHER}/${RESOURCE}.pdf`,
  });

  rpc
    .mockResolvedValueOnce({ data: true, error: null })
    .mockResolvedValueOnce({ data: "member", error: null });

  const { request, context } = remove();
  const response = await DELETE(request, context);

  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("not_found");

  expect(removeResourceObject).not.toHaveBeenCalled();
  expect(deleteResourceMetadata).not.toHaveBeenCalled();
});
});
