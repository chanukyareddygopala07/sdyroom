/**
 * Client-side attachment encryption (AES-256-GCM via WebCrypto). Community
 * attachments — files, GIFs — are encrypted BEFORE upload; the storage
 * bucket only ever holds ciphertext. The per-attachment key and IV travel
 * inside the E2EE message payload (see lib/communities/payload.ts), so
 * only members who can decrypt channel messages can decrypt attachments.
 *
 * The server's role is pure storage: it never receives the key, the IV, or
 * the plaintext, and cannot validate attachment content (documented in
 * docs/SECURITY.md — moderation of encrypted attachments is report-driven).
 */

const subtle = globalThis.crypto.subtle;

/** TS 5.7+ types Uint8Array's buffer generically; WebCrypto wants a plain
 * ArrayBuffer-backed view. All our views are plain ArrayBuffers at runtime. */
function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

export type EncryptedAttachment = {
  ciphertext: Uint8Array;
  keyB64: string;
  ivB64: string;
  /** Ciphertext byte length — the value registered via the attachments API. */
  size: number;
};

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptAttachment(
  plaintext: Uint8Array,
): Promise<EncryptedAttachment> {
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv }, key, bufferSource(plaintext)),
  );
  const rawKey = new Uint8Array(await subtle.exportKey("raw", key));
  return {
    ciphertext,
    keyB64: b64(rawKey),
    ivB64: b64(iv),
    size: ciphertext.byteLength,
  };
}

export async function decryptAttachment(
  ciphertext: Uint8Array,
  keyB64: string,
  ivB64: string,
): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", bufferSource(fromB64(keyB64)), "AES-GCM", false, [
    "decrypt",
  ]);
  return new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv: bufferSource(fromB64(ivB64)) },
      key,
      bufferSource(ciphertext),
    ),
  );
}

/**
 * The storage path for a community attachment. Namespaced by community and
 * channel so the bucket's RLS can re-derive membership from the prefix, and
 * ending in a random object id so paths are unguessable.
 */
export function communityAttachmentPath(
  communityId: string,
  channelId: string,
): { storagePath: string; attachmentId: string } {
  const attachmentId = crypto.randomUUID();
  return {
    storagePath: `community-attachments/${communityId}/${channelId}/${attachmentId}`,
    attachmentId,
  };
}

/** Read a File into bytes, enforcing the 10 MB ceiling before any crypto work. */
export async function readAttachmentFile(
  file: File,
  maxBytes: number,
): Promise<Uint8Array> {
  if (file.size > maxBytes) {
    throw new Error(
      `Attachments must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller.`,
    );
  }
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}
