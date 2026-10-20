import { POST } from "@/app/api/rooms/[id]/meeting/token/route";
import { MEETING_TOKEN_TTL_SECONDS } from "@/lib/meeting/config";
import { ModerationError } from "@/lib/moderation/errors";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  requireRoomMembership,
  getRoomModerationInfo,
  maybeSingle,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(),
  requireRoomMembership: vi.fn(),
  getRoomModerationInfo: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", () => ({ rateLimitedResponse }));
vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));
vi.mock("@/lib/moderation/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/queries")>()),
  getRoomModerationInfo,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const LIVEKIT_URL = "wss://example.livekit.cloud";
const LIVEKIT_API_KEY = "APIkeyEXAMPLE";
const LIVEKIT_API_SECRET = "secretEXAMPLEvalue1234567890";

function stubLiveKitEnv() {
  vi.stubEnv("LIVEKIT_URL", LIVEKIT_URL);
  vi.stubEnv("LIVEKIT_API_KEY", LIVEKIT_API_KEY);
  vi.stubEnv("LIVEKIT_API_SECRET", LIVEKIT_API_SECRET);
}

function post(body?: string, id: string = ROOM_ID) {
  return {
    request: new NextRequest(
      `http://localhost:3000/api/rooms/${id}/meeting/token`,
      {
        method: "POST",
        body,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
    ),
    context: { params: Promise.resolve({ id }) },
  };
}

/** Decodes the payload segment of the minted JWT without verifying it. */
function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("POST /api/rooms/[id]/meeting/token", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID } } });
    createClient.mockResolvedValue({
      auth: { getClaims },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ maybeSingle }),
        }),
      }),
    });
    maybeSingle.mockResolvedValue({ data: { alias: "studious-owl" }, error: null });
    rateLimitedResponse.mockResolvedValue(null);
    requireRoomMembership.mockResolvedValue(undefined);
    getRoomModerationInfo.mockResolvedValue({
      viewer_is_muted: false,
      muted_until: null,
      can_moderate: false,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated requests with 401", async () => {
    stubLiveKitEnv();
    getClaims.mockResolvedValue({ data: null });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("rejects a room id that is not a UUID", async () => {
    stubLiveKitEnv();
    const { request, context } = post("{}", "not-a-uuid");
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("rejects a body that is not JSON", async () => {
    stubLiveKitEnv();
    const { request, context } = post("{not json");
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("rejects a body that carries fields", async () => {
    stubLiveKitEnv();
    const { request, context } = post(JSON.stringify({ user_id: "someone" }));
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("answers 503 without spending a rate-limit slot when unconfigured", async () => {
    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("meeting_unavailable");
    expect(rateLimitedResponse).not.toHaveBeenCalled();
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("treats a partial provider configuration as unconfigured", async () => {
    vi.stubEnv("LIVEKIT_URL", LIVEKIT_URL);
    vi.stubEnv("LIVEKIT_API_KEY", LIVEKIT_API_KEY);
    vi.stubEnv("LIVEKIT_API_SECRET", "");

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("meeting_unavailable");
  });

  it("treats a non-websocket URL as unconfigured", async () => {
    vi.stubEnv("LIVEKIT_URL", "https://example.livekit.cloud");
    vi.stubEnv("LIVEKIT_API_KEY", LIVEKIT_API_KEY);
    vi.stubEnv("LIVEKIT_API_SECRET", LIVEKIT_API_SECRET);

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("meeting_unavailable");
  });

  it("passes the rate limiter's 429 through untouched", async () => {
    stubLiveKitEnv();
    const limited = new NextResponse(
      JSON.stringify({ error: { code: "rate_limited" } }),
      { status: 429, headers: { "Retry-After": "60" } },
    );
    rateLimitedResponse.mockResolvedValue(limited);

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(requireRoomMembership).not.toHaveBeenCalled();
  });

  it("answers 404 for a caller who is not a member", async () => {
    stubLiveKitEnv();
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(getRoomModerationInfo).not.toHaveBeenCalled();
  });

  it("maps moderation failures to their envelope", async () => {
    stubLiveKitEnv();
    getRoomModerationInfo.mockRejectedValue(
      new ModerationError("not_found", "That room is not available.", 404),
    );

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("mints a joinable token for a member", async () => {
    stubLiveKitEnv();

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      token: expect.any(String),
      url: LIVEKIT_URL,
      room: `sdyroom-${ROOM_ID}`,
      identity: USER_ID,
      expires_in: MEETING_TOKEN_TTL_SECONDS,
      can_publish_mic: true,
    });

    const claims = decodeClaims(body.token);
    expect(claims.iss).toBe(LIVEKIT_API_KEY);
    expect(claims.sub).toBe(USER_ID);
    const video = claims.video as Record<string, unknown>;
    expect(video.room).toBe(`sdyroom-${ROOM_ID}`);
    expect(video.roomJoin).toBe(true);
    expect(video.canPublish).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(video.canPublishSources).toBeUndefined();
    // The signing secret must never travel with the token.
    expect(JSON.stringify(body)).not.toContain(LIVEKIT_API_SECRET);
  });

  it("carries the caller's alias as the display name", async () => {
    stubLiveKitEnv();

    const { request, context } = post("{}");
    const response = await POST(request, context);
    const body = await response.json();

    const claims = decodeClaims(body.token);
    expect(claims.name).toBe("studious-owl");
  });

  it("drops the microphone from the grant for a muted member", async () => {
    stubLiveKitEnv();
    getRoomModerationInfo.mockResolvedValue({
      viewer_is_muted: true,
      muted_until: null,
      can_moderate: false,
    });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.can_publish_mic).toBe(false);

    const claims = decodeClaims(body.token);
    const video = claims.video as Record<string, unknown>;
    expect(video.canPublish).toBe(true);
    expect(video.canPublishSources).toEqual(["camera", "screen_share"]);
  });

  it("treats an expired mute as lifted", async () => {
    stubLiveKitEnv();
    getRoomModerationInfo.mockResolvedValue({
      viewer_is_muted: true,
      muted_until: "2000-01-01T00:00:00+00:00",
      can_moderate: false,
    });

    const { request, context } = post("{}");
    const response = await POST(request, context);
    const body = await response.json();

    expect(body.can_publish_mic).toBe(true);
  });

  it("returns 500 without leaking the failure detail when minting fails", async () => {
    stubLiveKitEnv();
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'relation "public.profiles" is locked' },
    });

    const { request, context } = post("{}");
    const response = await POST(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("meeting_token_failed");
    expect(JSON.stringify(body)).not.toContain("profiles");
  });
});
