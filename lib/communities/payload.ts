/**
 * Encrypted message payload shapes — the plaintext INSIDE MLS envelopes.
 * The server never sees these; they are encrypted client-side and decrypted
 * locally. Versioned (`v`) so the format can evolve without ambiguity.
 */

export const COMMUNITY_PAYLOAD_VERSION = 1;

export type CommunityTextPayload = {
  v: 1;
  t: "text";
  body: string;
  replyTo?: string;
};

export type CommunityStickerPayload = {
  v: 1;
  t: "sticker";
  pack: string;
  id: string;
  alt: string;
  replyTo?: string;
};

/** Attachment payloads carry the AES-256-GCM key INSIDE the E2EE envelope. */
export type CommunityAttachmentMeta = {
  attachmentId: string;
  keyB64: string;
  ivB64: string;
  name: string;
  mime: string;
  size: number;
};

export type CommunityGifPayload = {
  v: 1;
  t: "gif";
  attachment: CommunityAttachmentMeta;
  replyTo?: string;
};

export type CommunityFilePayload = {
  v: 1;
  t: "file";
  attachment: CommunityAttachmentMeta;
  replyTo?: string;
};

/** Reactions are their own encrypted messages referencing a target row id. */
export type CommunityReactionPayload = {
  v: 1;
  t: "reaction";
  targetId: string;
  emoji: string;
  removed?: boolean;
};

export type CommunityPayload =
  | CommunityTextPayload
  | CommunityStickerPayload
  | CommunityGifPayload
  | CommunityFilePayload
  | CommunityReactionPayload;

export function isTextPayload(
  payload: CommunityPayload,
): payload is CommunityTextPayload {
  return payload.t === "text";
}

export function isStickerPayload(
  payload: CommunityPayload,
): payload is CommunityStickerPayload {
  return payload.t === "sticker";
}

export function isGifPayload(
  payload: CommunityPayload,
): payload is CommunityGifPayload {
  return payload.t === "gif";
}

export function isFilePayload(
  payload: CommunityPayload,
): payload is CommunityFilePayload {
  return payload.t === "file";
}

export function isReactionPayload(
  payload: CommunityPayload,
): payload is CommunityReactionPayload {
  return payload.t === "reaction";
}

/** Defensive parse of a decrypted payload from an untrusted peer device. */
export function parseCommunityPayload(raw: unknown): CommunityPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.v !== COMMUNITY_PAYLOAD_VERSION) {
    return null;
  }
  switch (value.t) {
    case "text":
      return typeof value.body === "string"
        ? { v: 1, t: "text", body: value.body, ...("replyTo" in value && typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {}) }
        : null;
    case "sticker":
      return typeof value.pack === "string" &&
        typeof value.id === "string" &&
        typeof value.alt === "string"
        ? { v: 1, t: "sticker", pack: value.pack, id: value.id, alt: value.alt, ...("replyTo" in value && typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {}) }
        : null;
    case "gif":
    case "file":
      return isAttachmentMeta(value.attachment)
        ? {
            v: 1,
            t: value.t,
            attachment: value.attachment as CommunityAttachmentMeta,
            ...("replyTo" in value && typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {}),
          }
        : null;
    case "reaction":
      return typeof value.targetId === "string" && typeof value.emoji === "string"
        ? {
            v: 1,
            t: "reaction",
            targetId: value.targetId,
            emoji: value.emoji,
            ...(value.removed === true ? { removed: true } : {}),
          }
        : null;
    default:
      return null;
  }
}

function isAttachmentMeta(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const value = raw as Record<string, unknown>;
  return (
    typeof value.attachmentId === "string" &&
    typeof value.keyB64 === "string" &&
    typeof value.ivB64 === "string" &&
    typeof value.name === "string" &&
    typeof value.mime === "string" &&
    typeof value.size === "number"
  );
}
