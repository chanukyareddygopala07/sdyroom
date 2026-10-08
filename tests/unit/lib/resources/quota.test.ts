import {
  fetchResourceQuota,
  resourceQuotaOk,
  type ResourceQuota,
} from "@/lib/resources/quota";
import { beforeEach, describe, expect, it, vi } from "vitest";

const QUOTA: ResourceQuota = {
  scope: "room",
  used_bytes: 2_097_152,
  limit_bytes: 524_288_000,
  user_used_bytes: 1_048_576,
  user_limit_bytes: 1_073_741_824,
};

function clientWith(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as never;
}

describe("resourceQuotaOk", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("passes the scope and byte count to the RPC", async () => {
    const rpc = vi.fn(async () => ({ data: true }));

    await expect(resourceQuotaOk(clientWith(rpc), "room-1", 4096)).resolves.toBe(
      true,
    );
    expect(rpc).toHaveBeenCalledWith("resource_quota_ok", {
      p_room_id: "room-1",
      p_add_bytes: 4096,
    });
  });

  it("passes a null room id for the personal library", async () => {
    const rpc = vi.fn(async () => ({ data: true }));

    await resourceQuotaOk(clientWith(rpc), null, 4096);

    expect(rpc).toHaveBeenCalledWith("resource_quota_ok", {
      p_room_id: null,
      p_add_bytes: 4096,
    });
  });

  it("refuses only on an explicit false", async () => {
    const rpc = vi.fn(async () => ({ data: false }));

    await expect(resourceQuotaOk(clientWith(rpc), null, 1)).resolves.toBe(false);
  });

  it("fails open when the RPC errors", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "function resource_quota_ok does not exist" },
    }));

    await expect(resourceQuotaOk(clientWith(rpc), null, 1)).resolves.toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("fails open when the client throws", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(resourceQuotaOk(clientWith(rpc), null, 1)).resolves.toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("fails open on an unexpected payload shape", async () => {
    const rpc = vi.fn(async () => ({ data: { unexpected: true } }));

    await expect(resourceQuotaOk(clientWith(rpc), null, 1)).resolves.toBe(true);
  });
});

describe("fetchResourceQuota", () => {
  it("returns the quota the RPC produced", async () => {
    const rpc = vi.fn(async () => ({ data: QUOTA }));

    await expect(fetchResourceQuota(clientWith(rpc), "room-1")).resolves.toEqual(
      QUOTA,
    );
    expect(rpc).toHaveBeenCalledWith("resource_quota", { p_room_id: "room-1" });
  });

  it("throws when the RPC errors, so the caller can answer 500", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "permission denied for function resource_quota" },
    }));

    await expect(fetchResourceQuota(clientWith(rpc), null)).rejects.toThrow(
      /resource quota failed/,
    );
  });

  it("throws when the payload is missing the byte counters", async () => {
    const rpc = vi.fn(async () => ({ data: { scope: "user" } }));

    await expect(fetchResourceQuota(clientWith(rpc), null)).rejects.toThrow(
      /unexpected shape/,
    );
  });

  it("throws on a null payload rather than rendering a silent zero", async () => {
    const rpc = vi.fn(async () => ({ data: null }));

    await expect(fetchResourceQuota(clientWith(rpc), null)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
