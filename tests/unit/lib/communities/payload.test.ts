import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PAYLOAD_VERSION,
  isFilePayload,
  isGifPayload,
  isReactionPayload,
  isStickerPayload,
  isTextPayload,
  parseCommunityPayload,
  type CommunityAttachmentMeta,
  type CommunityPayload,
} from "@/lib/communities/payload";

const attachment: CommunityAttachmentMeta = {
  attachmentId: "a1",
  keyB64: "k".repeat(44),
  ivB64: "i".repeat(16),
  name: "notes.pdf",
  mime: "application/pdf",
  size: 2048,
};

describe("parseCommunityPayload", () => {
  it("parses every documented payload kind", () => {
    const cases: CommunityPayload[] = [
      { v: 1, t: "text", body: "hello" },
      { v: 1, t: "text", body: "hi", replyTo: "m1" },
      { v: 1, t: "sticker", pack: "classic", id: "wave", alt: "waving" },
      { v: 1, t: "gif", attachment },
      { v: 1, t: "file", attachment },
      { v: 1, t: "reaction", targetId: "m1", emoji: "🔥" },
      { v: 1, t: "reaction", targetId: "m1", emoji: "🔥", removed: true },
    ];
    for (const payload of cases) {
      expect(parseCommunityPayload(JSON.parse(JSON.stringify(payload)))).toEqual(
        payload,
      );
    }
  });

  it("is defensive about peers: wrong version, kind, or field types fail", () => {
    expect(parseCommunityPayload(null)).toBeNull();
    expect(parseCommunityPayload("text")).toBeNull();
    expect(parseCommunityPayload({ v: 2, t: "text", body: "hi" })).toBeNull();
    expect(parseCommunityPayload({ v: 1 })).toBeNull();
    expect(parseCommunityPayload({ v: 1, t: "text", body: 42 })).toBeNull();
    expect(parseCommunityPayload({ v: 1, t: "unknown" })).toBeNull();
    expect(
      parseCommunityPayload({ v: 1, t: "sticker", pack: 1, id: 2, alt: 3 }),
    ).toBeNull();
    expect(parseCommunityPayload({ v: 1, t: "file" })).toBeNull();
    expect(
      parseCommunityPayload({ v: 1, t: "reaction", targetId: 1, emoji: 2 }),
    ).toBeNull();
  });

  it("keeps only string replyTo and drops a non-string one", () => {
    expect(
      parseCommunityPayload({ v: 1, t: "text", body: "hi", replyTo: "m9" }),
    ).toMatchObject({ replyTo: "m9" });
    const dropped = parseCommunityPayload({
      v: 1,
      t: "text",
      body: "hi",
      replyTo: { id: "m9" },
    });
    expect(dropped).toEqual({ v: 1, t: "text", body: "hi" });
    expect(dropped && "replyTo" in dropped).toBe(false);
  });

  it("only sets removed when strictly true", () => {
    expect(
      parseCommunityPayload({
        v: 1,
        t: "reaction",
        targetId: "m1",
        emoji: "x",
        removed: "yes",
      }),
    ).toEqual({ v: 1, t: "reaction", targetId: "m1", emoji: "x" });
  });

  it("validates every attachment field", () => {
    const bad = { ...attachment, size: "big" };
    expect(parseCommunityPayload({ v: 1, t: "gif", attachment: bad })).toBeNull();
    expect(
      parseCommunityPayload({
        v: 1,
        t: "file",
        attachment: { ...attachment, keyB64: 7 },
      }),
    ).toBeNull();
  });

  it("drops unknown extra keys (single source of truth for rendering)", () => {
    const parsed = parseCommunityPayload({
      v: 1,
      t: "text",
      body: "hi",
      __proto_pollution: "nope",
      isAdmin: true,
    });
    expect(parsed).toEqual({ v: 1, t: "text", body: "hi" });
    expect(Object.keys(parsed ?? {})).toEqual(["v", "t", "body"]);
  });

  it("exposes the pinned payload version", () => {
    expect(COMMUNITY_PAYLOAD_VERSION).toBe(1);
  });
});

describe("payload type guards", () => {
  const payload: CommunityPayload = { v: 1, t: "text", body: "hey" };

  it("discriminates on t", () => {
    expect(isTextPayload(payload)).toBe(true);
    expect(isStickerPayload(payload)).toBe(false);
    expect(isGifPayload(payload)).toBe(false);
    expect(isFilePayload(payload)).toBe(false);
    expect(isReactionPayload(payload)).toBe(false);
  });
});
