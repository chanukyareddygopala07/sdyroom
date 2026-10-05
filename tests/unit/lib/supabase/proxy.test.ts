import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const { getClaims } = vi.hoisted(() => ({
  getClaims: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { getClaims } })),
}));

const SUPABASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
};

async function loadUpdateSession(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const { updateSession } = await import("@/lib/supabase/proxy");
  return updateSession;
}

function request(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function redirectPath(response: Response) {
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("updateSession", () => {
  it("redirects an unauthenticated visitor on a protected route to login", async () => {
    getClaims.mockResolvedValue({ data: { claims: null } });
    const updateSession = await loadUpdateSession(SUPABASE_ENV);

    const response = await updateSession(request("/protected"));

    expect(response.status).toBe(307);
    expect(redirectPath(response)).toBe("/auth/login");
  });

  it("lets an authenticated visitor through on a protected route", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: "user-1", role: "authenticated" } },
    });
    const updateSession = await loadUpdateSession(SUPABASE_ENV);

    const response = await updateSession(request("/protected"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("never redirects the public landing page", async () => {
    getClaims.mockResolvedValue({ data: { claims: null } });
    const updateSession = await loadUpdateSession(SUPABASE_ENV);

    const response = await updateSession(request("/"));

    expect(response.headers.get("location")).toBeNull();
  });

  it.each(["/auth/login", "/auth/sign-up", "/auth/confirm", "/login"])(
    "never redirects the auth route %s",
    async (path) => {
      getClaims.mockResolvedValue({ data: { claims: null } });
      const updateSession = await loadUpdateSession(SUPABASE_ENV);

      const response = await updateSession(request(path));

      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("skips the auth check entirely when Supabase env vars are absent", async () => {
    getClaims.mockResolvedValue({ data: { claims: null } });
    const updateSession = await loadUpdateSession({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
    });

    const response = await updateSession(request("/protected"));

    expect(getClaims).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
  });
});
