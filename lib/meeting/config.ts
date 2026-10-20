/**
 * Server-side LiveKit configuration — the single place the `LIVEKIT_*`
 * environment variables are read and interpreted.
 *
 * Rules (mirrored from `lib/ai/config.ts`, published in README and
 * docs/DEVELOPMENT.md, asserted by unit tests):
 *
 *   * never `NEXT_PUBLIC_*` — the URL, API key and API secret stay out of the
 *     browser bundle; the client only ever learns the URL from the token
 *     endpoint's response, and the API secret never leaves the server;
 *   * all three are required: a partially configured provider is treated as
 *     unconfigured, so the workspace shows an honest "not available" state
 *     instead of a join button that would fail;
 *   * the URL must be a `ws://` or `wss://` endpoint — a typo (an `https://`
 *     copy-paste, for example) is logged by variable name, never by value, and
 *     still counts as unconfigured rather than failing at connect time.
 *
 * Reading the environment on every call (no module-level memo) keeps unit
 * tests free to vary `process.env` between cases; the cost is three property
 * reads per request.
 */
import { logWarn } from "@/lib/server/log";

export type MeetingConfig = {
  /** LiveKit server endpoint, always `ws://` or `wss://`. */
  url: string;
  /** Token-signing issuer (LiveKit API key). */
  apiKey: string;
  /** Token-signing secret. Server-only; never logged, never serialised. */
  apiSecret: string;
};

/**
 * How long an issued meeting token stays valid. Only the *initial* connection
 * checks expiry (LiveKit keeps an established session alive across reconnects),
 * so ten minutes comfortably covers a join plus any immediate retry while
 * keeping a dropped token useless for long.
 */
export const MEETING_TOKEN_TTL = "10m";
export const MEETING_TOKEN_TTL_SECONDS = 600;

/**
 * The LiveKit room name derived from a study room id. LiveKit logs room names,
 * so this is deliberately opaque: an app-internal UUID and nothing else — no
 * room title, no alias, no PII.
 */
export function livekitRoomName(roomId: string): string {
  return `sdyroom-${roomId}`;
}

/**
 * Reads the provider configuration, or `null` when it is missing/incomplete.
 * Values are returned so the caller can mint a token; they must never be
 * logged (`lib/server/log.ts` redacts `token`/`secret` keys, and this module
 * never logs them under any key).
 */
export function getMeetingConfig(): MeetingConfig | null {
  const url = (process.env.LIVEKIT_URL ?? "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY ?? "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET ?? "").trim();

  if (url === "" || apiKey === "" || apiSecret === "") {
    return null;
  }
  if (!/^wss?:\/\/.+/.test(url)) {
    // Log the variable name only — never the value, so a mis-set URL cannot
    // leak through the logs while still being diagnosable.
    logWarn("[meeting/config] LIVEKIT_URL must start with ws:// or wss://");
    return null;
  }
  return { url, apiKey, apiSecret };
}

/** Whether live meetings can be offered at all on this deployment. */
export function isMeetingConfigured(): boolean {
  return getMeetingConfig() !== null;
}
