import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyEnvelope,
  createChannelGroup,
  encryptForChannel,
  ensureDevice,
} from "@/lib/crypto/mls";
import { __resetStorageForTests } from "@/lib/crypto/storage";

/**
 * Pins the ts-mls contract the product designs around: a SENDER cannot
 * re-decrypt envelopes it produced. `createApplicationMessage` consumes the
 * used generation (returned in `consumed` for the caller to zero) and the
 * post-send ratchet sits one generation past the message, so
 * `ratchetToGeneration` rejects it ("Desired gen in the past") unless the
 * generation was archived — which the send path never does. MLS itself only
 * requires recipients to decrypt; senders read their own history from the
 * local plaintext cache (`rememberOwnMessage`/`recallOwnMessage`), which
 * `useCommunityWorkspace` checks before ever attempting decryption.
 *
 * If a future ts-mls release starts archiving the sender's generation, the
 * first test below fails loudly and the cache layer becomes belt-and-braces
 * rather than load-bearing — update docs/SECURITY.md accordingly.
 */

const COMMUNITY = "11111111-1111-1111-1111-111111111111";
const CHANNEL = "22222222-2222-2222-2222-222222222222";

describe("founder-alone sender contract", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __resetStorageForTests();
  });

  it("rejects the founder's own envelope in the decrypt path", async () => {
    await ensureDevice();
    const setup = await createChannelGroup(COMMUNITY, CHANNEL, []);
    expect(setup.commit).toBeNull();
    expect(setup.welcomes).toHaveLength(0);

    const envelope = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "hello before the join",
    });
    expect(envelope).toMatch(/^[A-Za-z0-9+/=]+$/);

    await expect(
      applyEnvelope(COMMUNITY, CHANNEL, {
        seq: 1,
        kind: "application",
        ciphertext: envelope,
      }),
    ).rejects.toThrow();
  });

  it("keeps sending: consecutive encrypts advance and persist the ratchet", async () => {
    await ensureDevice();
    await createChannelGroup(COMMUNITY, CHANNEL, []);

    const first = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "one",
    });
    const second = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "two",
    });
    expect(first).not.toBe(second);

    // Both remain sendable wire artifacts (base64 envelopes).
    for (const envelope of [first, second]) {
      expect(envelope).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });
});
