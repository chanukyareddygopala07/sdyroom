/**
 * Meeting-token minting: the only place a LiveKit access token is created.
 *
 * Grants are kept to the minimum a browser meeting needs, and every grant
 * decision lives here so the unit tests can decode one JWT and assert the
 * whole permission surface:
 *
 *   * `roomJoin` + `room` bound the token to exactly one study room — a token
 *     for room A is meaningless in room B;
 *   * `identity` is the session's opaque user id (LiveKit logs identities, so
 *     no alias, email or room title goes in it); the participant *display
 *     name* is the study alias, which is already a pseudonym inside SdyRoom;
 *   * `canPublish` / `canSubscribe` enable the meeting itself. `canPublishData`
 *     is left unset on purpose: LiveKit derives it from `canPublish`
 *     (`auth/grants.go`: "defaults to true if not set"), so the payload stays
 *     explicit about what SdyRoom actually decided;
 *   * an active room mute (the existing moderation surface) silences the
 *     *microphone* grant for the joining participant: `canPublishSources`
 *     supersedes `canPublish` when set, so camera and screen share stay
 *     available while the microphone cannot be published. The same mute is
 *     still enforced per-message in chat — this mapping only carries the
 *     restriction into the meeting;
 *   * nothing else: `roomAdmin`, `roomCreate`, `roomList`, `roomRecord`,
 *     `ingressAdmin`, `hidden` and `recorder` are never granted, so a stolen
 *     meeting token cannot moderate the LiveKit room, list rooms or record.
 *
 * The API secret is read from the server-side config only; it never reaches
 * the client bundle or the response body (the response carries the signed
 * token, never the key material that signed it).
 */
import { AccessToken, TrackSource, type VideoGrant } from "livekit-server-sdk";
import {
  MEETING_TOKEN_TTL,
  MEETING_TOKEN_TTL_SECONDS,
  livekitRoomName,
  type MeetingConfig,
} from "./config";

export type MeetingTokenInput = {
  /** Study room the token joins. */
  roomId: string;
  /** Session user id — the participant identity (opaque). */
  userId: string;
  /** Study alias shown as the participant display name (already a pseudonym). */
  alias: string;
  /** True when the caller has an active room mute (microphone silenced). */
  silenced: boolean;
};

export type MeetingTokenResult = {
  token: string;
  url: string;
  room: string;
  identity: string;
  expires_in: number;
  can_publish_mic: boolean;
};

/**
 * Mints a short-lived join token for exactly one room and one participant.
 * Throws only on an internal signing failure — authorization has already
 * happened in the route before this is called.
 */
export async function createMeetingToken(
  config: MeetingConfig,
  input: MeetingTokenInput,
): Promise<MeetingTokenResult> {
  const room = livekitRoomName(input.roomId);

  const accessToken = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.userId,
    name: input.alias,
    ttl: MEETING_TOKEN_TTL,
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
  };
  if (input.silenced) {
    // Numeric enum values: `claimsToJwtPayload` maps these to the string
    // sources LiveKit expects; raw strings would throw while signing.
    grant.canPublishSources = [TrackSource.CAMERA, TrackSource.SCREEN_SHARE];
  }
  accessToken.addGrant(grant);

  const token = await accessToken.toJwt();

  return {
    token,
    url: config.url,
    room,
    identity: input.userId,
    expires_in: MEETING_TOKEN_TTL_SECONDS,
    can_publish_mic: !input.silenced,
  };
}
