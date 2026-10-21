/**
 * Base64 helpers that work identically in browsers and Node (vitest). The
 * MLS layer moves every byte — envelopes, key packages, group state — as
 * standard base64 strings, which is also the storage/API wire format.
 */

const B64_CHUNK = 0x8000;

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
