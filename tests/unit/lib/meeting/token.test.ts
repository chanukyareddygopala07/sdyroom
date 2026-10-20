import type { MeetingConfig } from "@/lib/meeting/config";
import { createMeetingToken } from "@/lib/meeting/token";
import { describe, expect, it } from "vitest";

const config: MeetingConfig = {
  url: "wss://example.livekit.cloud",
  apiKey: "APIkeyEXAMPLE",
  apiSecret: "secretEXAMPLEvalue1234567890",
};

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("createMeetingToken", () => {
  it("signs a room-join grant scoped to one opaque room name", async () => {
    const result = await createMeetingToken(config, {
      roomId: ROOM_ID,
      userId: USER_ID,
      alias: "studious-owl",
      silenced: false,
    });

    expect(result).toEqual({
      token: expect.any(String),
      url: config.url,
      room: `sdyroom-${ROOM_ID}`,
      identity: USER_ID,
      expires_in: 600,
      can_publish_mic: true,
    });

    const claims = decodeClaims(result.token);
    expect(claims.iss).toBe(config.apiKey);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.name).toBe("studious-owl");
    const video = claims.video as Record<string, unknown>;
    expect(video).toEqual(
      expect.objectContaining({
        room: `sdyroom-${ROOM_ID}`,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      }),
    );
    // No admin powers, ever.
    expect(video.roomAdmin).toBeUndefined();
    expect(video.roomCreate).toBeUndefined();
    expect(video.roomList).toBeUndefined();
    expect(video.roomRecord).toBeUndefined();
    expect(video.ingressAdmin).toBeUndefined();
    // Data publishing and metadata updates stay server-controlled.
    expect(video.canPublishData).toBeUndefined();
    expect(video.canUpdateOwnMetadata).toBeUndefined();
  });

  it("grants camera and screen-share only when silenced", async () => {
    const result = await createMeetingToken(config, {
      roomId: ROOM_ID,
      userId: USER_ID,
      alias: "muted-fox",
      silenced: true,
    });

    expect(result.can_publish_mic).toBe(false);
    const claims = decodeClaims(result.token);
    const video = claims.video as Record<string, unknown>;
    expect(video.canPublish).toBe(true);
    expect(video.canPublishSources).toEqual(["camera", "screen_share"]);
  });

  it("never carries the signing secret in the token", async () => {
    const result = await createMeetingToken(config, {
      roomId: ROOM_ID,
      userId: USER_ID,
      alias: "studious-owl",
      silenced: false,
    });

    expect(result.token).not.toContain(config.apiSecret);
  });
});
