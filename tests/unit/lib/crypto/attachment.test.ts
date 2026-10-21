import { describe, expect, it } from "vitest";
import {
  communityAttachmentPath,
  decryptAttachment,
  encryptAttachment,
  readAttachmentFile,
} from "@/lib/crypto/attachment";

const COMMUNITY = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const CHANNEL = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";

describe("encryptAttachment / decryptAttachment", () => {
  it("round-trips bytes and reports the ciphertext size", async () => {
    const plaintext = new TextEncoder().encode("secret attachment bytes");
    const encrypted = await encryptAttachment(plaintext);

    expect(encrypted.size).toBe(encrypted.ciphertext.byteLength);
    expect(encrypted.ciphertext.byteLength).toBe(plaintext.byteLength + 16);
    expect(encrypted.keyB64).toBeTruthy();
    expect(encrypted.ivB64).toBeTruthy();
    // Ciphertext must not contain the plaintext (trivially, but assert it).
    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain(
      "secret attachment",
    );

    const decrypted = await decryptAttachment(
      encrypted.ciphertext,
      encrypted.keyB64,
      encrypted.ivB64,
    );
    expect(new TextDecoder().decode(decrypted)).toBe(
      "secret attachment bytes",
    );
  });

  it("uses a fresh key and IV per call (same plaintext, different ciphertext)", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const a = await encryptAttachment(plaintext);
    const b = await encryptAttachment(plaintext);
    expect(a.keyB64).not.toBe(b.keyB64);
    expect(a.ivB64).not.toBe(b.ivB64);
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  it("rejects tampered ciphertext and wrong keys (AES-GCM auth)", async () => {
    const plaintext = new Uint8Array([9, 9, 9, 9]);
    const encrypted = await encryptAttachment(plaintext);

    const tampered = Uint8Array.from(encrypted.ciphertext);
    tampered[0] ^= 0xff;
    await expect(
      decryptAttachment(tampered, encrypted.keyB64, encrypted.ivB64),
    ).rejects.toThrow();

    const other = await encryptAttachment(new Uint8Array([1]));
    await expect(
      decryptAttachment(
        encrypted.ciphertext,
        other.keyB64,
        encrypted.ivB64,
      ),
    ).rejects.toThrow();
  });

  it("handles empty plaintext and non-UTF8 bytes", async () => {
    const empty = await encryptAttachment(new Uint8Array(0));
    expect(empty.size).toBe(16);
    const roundTrip = await decryptAttachment(
      empty.ciphertext,
      empty.keyB64,
      empty.ivB64,
    );
    expect(roundTrip.byteLength).toBe(0);

    const binary = new Uint8Array([0, 255, 128, 7]);
    const encrypted = await encryptAttachment(binary);
    const decrypted = await decryptAttachment(
      encrypted.ciphertext,
      encrypted.keyB64,
      encrypted.ivB64,
    );
    expect(Array.from(decrypted)).toEqual([0, 255, 128, 7]);
  });
});

describe("communityAttachmentPath", () => {
  it("builds the bucket path from community and channel ids", () => {
    const { storagePath, attachmentId } = communityAttachmentPath(
      COMMUNITY,
      CHANNEL,
    );
    expect(storagePath).toBe(
      `community-attachments/${COMMUNITY}/${CHANNEL}/${attachmentId}`,
    );
    expect(attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(storagePath.split("/")).toHaveLength(4);
  });

  it("generates an unguessable id per call", () => {
    const first = communityAttachmentPath(COMMUNITY, CHANNEL).attachmentId;
    const second = communityAttachmentPath(COMMUNITY, CHANNEL).attachmentId;
    expect(first).not.toBe(second);
  });
});

describe("readAttachmentFile", () => {
  it("reads a File into bytes under the ceiling", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.bin");
    const bytes = await readAttachmentFile(file, 1024);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("refuses files above the ceiling before any crypto work", async () => {
    const file = new File([new Uint8Array(64)], "big.bin");
    await expect(readAttachmentFile(file, 32)).rejects.toThrow(
      /smaller|MB/,
    );
  });
});
