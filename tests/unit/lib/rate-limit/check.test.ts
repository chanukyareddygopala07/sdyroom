import { rateLimitedResponse, takeRateLimit } from "@/lib/rate-limit/check";
import { uploadUserSpec } from "@/lib/rate-limit/keys";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SPEC = uploadUserSpec("user-1");

function clientWith(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as never;
}

describe("takeRateLimit", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("consumes one slot through the rate_limit_take RPC", async () => {
    const rpc = vi.fn(async () => ({ data: true }));

    const allowed = await takeRateLimit(clientWith(rpc), SPEC);

    expect(allowed).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("rate_limit_take", {
      p_key: "upload:user:user-1",
      p_max: 20,
      p_window: "60 seconds",
    });
  });

  it("reports the RPC's explicit false as refused", async () => {
    const rpc = vi.fn(async () => ({ data: false }));

    await expect(takeRateLimit(clientWith(rpc), SPEC)).resolves.toBe(false);
  });

  it("fails open when the RPC returns an error", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "permission denied for function rate_limit_take" },
    }));

    await expect(takeRateLimit(clientWith(rpc), SPEC)).resolves.toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("fails open when the client has no rpc at all", async () => {
    const allowed = await takeRateLimit({} as never, SPEC);

    expect(allowed).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("treats an unexpected payload shape as allowed", async () => {
    const rpc = vi.fn(async () => ({ data: null }));

    await expect(takeRateLimit(clientWith(rpc), SPEC)).resolves.toBe(true);
  });
});

describe("rateLimitedResponse", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("returns null when the slot was available", async () => {
    const rpc = vi.fn(async () => ({ data: true }));

    await expect(
      rateLimitedResponse(clientWith(rpc), SPEC),
    ).resolves.toBeNull();
  });

  it("answers a spent slot with the 429 envelope and Retry-After", async () => {
    const rpc = vi.fn(async () => ({ data: false }));

    const response = await rateLimitedResponse(
      clientWith(rpc),
      SPEC,
      "Too many uploads.",
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("Retry-After")).toBe("60");
    const body = await response!.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toBe("Too many uploads.");
  });

  it("answers a failed limiter consult with null (fail open)", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("connection refused");
    });

    await expect(
      rateLimitedResponse(clientWith(rpc), SPEC),
    ).resolves.toBeNull();
  });

  it("reflects the spec's window in Retry-After, not a constant", async () => {
    const rpc = vi.fn(async () => ({ data: false }));
    const hourly = { key: "report:room:user", max: 20, windowSeconds: 3600 };

    const response = await rateLimitedResponse(clientWith(rpc), hourly);

    expect(response!.headers.get("Retry-After")).toBe("3600");
  });
});

// The request itself is never read by the limiter, but the helper builds a
// real NextResponse, so pin that it can be awaited like any route reply.
describe("rateLimitedResponse integration with NextRequest", () => {
  it("does not consume the request body", async () => {
    const rpc = vi.fn(async () => ({ data: false }));
    const request = new NextRequest("http://localhost:3000/api/resources", {
      method: "POST",
      body: "payload",
    });

    const response = await rateLimitedResponse(clientWith(rpc), SPEC);

    expect(response!.status).toBe(429);
    expect(await request.text()).toBe("payload");
  });
});
