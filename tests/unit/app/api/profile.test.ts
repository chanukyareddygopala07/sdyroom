import { POST } from "@/app/api/profile/route";
import { ProfileError } from "@/lib/profiles/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getClaims, getProfile, createProfile } = vi.hoisted(
  () => ({
    createClient: vi.fn(),
    getClaims: vi.fn(),
    getProfile: vi.fn(),
    createProfile: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/profiles/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/queries")>()),
  getProfile,
  createProfile,
}));

function postRequest(body: string) {
  return new NextRequest("http://localhost:3000/api/profile", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/profile", () => {
  beforeEach(() => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    getProfile.mockResolvedValue(null);
    createProfile.mockResolvedValue({ id: "user-1", alias: "examnerd" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await POST(postRequest(JSON.stringify({ alias: "nerd" })));

    expect(response.status).toBe(401);
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON with 400", async () => {
    const response = await POST(postRequest("not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("rejects an invalid alias with 400", async () => {
    const response = await POST(postRequest(JSON.stringify({ alias: "" })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues[0].path).toBe("alias");
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("returns the existing profile without inserting when already onboarded", async () => {
    getProfile.mockResolvedValue({ id: "user-1", alias: "examnerd" });

    const response = await POST(
      postRequest(JSON.stringify({ alias: "someone-else" })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: { id: "user-1", alias: "examnerd" },
      created: false,
    });
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("creates the profile for the session user", async () => {
    const response = await POST(postRequest(JSON.stringify({ alias: "  examnerd  " })));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      profile: { id: "user-1", alias: "examnerd" },
      created: true,
    });
    expect(createProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "examnerd",
    );
  });

  it("maps a taken alias onto 409", async () => {
    createProfile.mockRejectedValue(
      new ProfileError(
        "alias_taken",
        "That study alias is already taken. Try another one.",
        409,
      ),
    );

    const response = await POST(postRequest(JSON.stringify({ alias: "examnerd" })));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("alias_taken");
  });

  it("returns 500 when the lookup fails", async () => {
    getProfile.mockRejectedValue(new Error("connection lost"));

    const response = await POST(postRequest(JSON.stringify({ alias: "examnerd" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("returns 500 when the insert fails unexpectedly", async () => {
    createProfile.mockRejectedValue(new Error("boom"));

    const response = await POST(postRequest(JSON.stringify({ alias: "examnerd" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
  });
});
