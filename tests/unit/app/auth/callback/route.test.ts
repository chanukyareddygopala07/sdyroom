import { GET } from "@/app/auth/callback/route";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeCodeForSession } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession } }),
}));

function request(query: string) {
  return new NextRequest(`http://localhost:3000/auth/callback${query}`);
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset();
  });

  it("exchanges the PKCE code and lands on the default room list", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(request("?code=test-code"));

    expect(exchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/rooms",
    );
  });

  it("honours a validated next target from the sign-in form", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(
      request(`?code=test-code&next=${encodeURIComponent("/analytics")}`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/analytics",
    );
  });

  it("drops an attacker-controlled absolute-URL next and falls back to /rooms", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(
      request(`?code=test-code&next=${encodeURIComponent("https://evil.example/phish")}`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/rooms",
    );
  });

  it("drops a protocol-relative next and falls back to /rooms", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(
      request(`?code=test-code&next=${encodeURIComponent("//evil.example")}`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/rooms",
    );
  });

  it("redirects to the login error state when the provider reports an error", async () => {
    const response = await GET(request("?error=access_denied&code=never"));

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/login?error=oauth",
    );
  });

  it("redirects to the login error state when the code exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "invalid request: PKCE verification failed" },
    });

    const response = await GET(request("?code=stale-code"));

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/auth/login?error=oauth",
    );
  });

  it("redirects to the default landing when the callback arrives with no code", async () => {
    const response = await GET(request(""));

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/rooms",
    );
  });
});
