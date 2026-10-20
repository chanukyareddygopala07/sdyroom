import {
  getMeetingConfig,
  isMeetingConfigured,
  livekitRoomName,
  MEETING_TOKEN_TTL,
  MEETING_TOKEN_TTL_SECONDS,
} from "@/lib/meeting/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../../helpers/log-capture";

const MEETING_KEYS = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of MEETING_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MEETING_KEYS) {
    const value = saved.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

function setFullConfig() {
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "APIkeyEXAMPLE";
  process.env.LIVEKIT_API_SECRET = "secretEXAMPLEvalue1234567890";
}

describe("getMeetingConfig", () => {
  it("returns null with nothing configured", () => {
    expect(getMeetingConfig()).toBeNull();
    expect(isMeetingConfigured()).toBe(false);
  });

  it.each([["LIVEKIT_URL"], ["LIVEKIT_API_KEY"], ["LIVEKIT_API_SECRET"]])(
    "treats a missing %s as unconfigured",
    (missing) => {
      setFullConfig();
      delete process.env[missing];

      expect(getMeetingConfig()).toBeNull();
      expect(isMeetingConfigured()).toBe(false);
    },
  );

  it("trims whitespace-only values down to absent", () => {
    setFullConfig();
    process.env.LIVEKIT_API_SECRET = "   ";

    expect(getMeetingConfig()).toBeNull();
  });

  it("accepts ws:// and wss:// endpoints", () => {
    setFullConfig();
    process.env.LIVEKIT_URL = "ws://localhost:7880";
    expect(getMeetingConfig()?.url).toBe("ws://localhost:7880");

    process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
    expect(getMeetingConfig()?.url).toBe("wss://example.livekit.cloud");
  });

  it.each([
    ["https:// copy-paste", "https://example.livekit.cloud"],
    ["bare host", "example.livekit.cloud"],
  ])("rejects %s and logs the variable name without its value", (_label, url) => {
    setFullConfig();
    process.env.LIVEKIT_URL = url;

    const { lines, restore } = captureLogs();
    expect(getMeetingConfig()).toBeNull();
    const warns = lines.filter((line) => line.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].event).toBe(
      "[meeting/config] LIVEKIT_URL must start with ws:// or wss://",
    );
    expect(JSON.stringify(lines)).not.toContain(url);
    restore();

    expect(isMeetingConfigured()).toBe(false);
  });

  it("returns the parsed values when fully configured", () => {
    setFullConfig();

    expect(getMeetingConfig()).toEqual({
      url: "wss://example.livekit.cloud",
      apiKey: "APIkeyEXAMPLE",
      apiSecret: "secretEXAMPLEvalue1234567890",
    });
    expect(isMeetingConfigured()).toBe(true);
  });
});

describe("livekitRoomName", () => {
  it("stays an opaque UUID — no title, no alias, no PII", () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    expect(livekitRoomName(roomId)).toBe(`sdyroom-${roomId}`);
  });
});

describe("token lifetime constants", () => {
  it("matches the documented TTL", () => {
    expect(MEETING_TOKEN_TTL).toBe("10m");
    expect(MEETING_TOKEN_TTL_SECONDS).toBe(600);
  });
});
