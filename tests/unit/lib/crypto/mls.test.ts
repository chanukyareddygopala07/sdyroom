import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  addDevicesToGroup,
  applyEnvelope,
  applyWelcome,
  createChannelGroup,
  encryptForChannel,
  ensureDevice,
  listGroupDeviceIds,
  removeCommunityLocalState,
  removeDeviceFromGroup,
  removeSelfFromGroup,
} from "@/lib/crypto/mls";
import {
  __resetStorageForTests,
  loadGroup,
  recallOwnMessage,
  rememberOwnMessage,
} from "@/lib/crypto/storage";

/**
 * End-to-end validation of the community MLS wrapper against the real
 * ts-mls implementation: the exact wire sequences the app will run.
 *
 * Each simulated browser is a separate `IDBFactory` instance — the same
 * per-profile isolation the product relies on. `useBrowser` swaps the
 * global factory and drops the cached DB handle, so "switching devices"
 * is exactly "opening another browser profile".
 */

const COMMUNITY = "11111111-1111-1111-1111-111111111111";
const CHANNEL = "22222222-2222-2222-2222-222222222222";

function newBrowser(): IDBFactory {
  globalThis.indexedDB = new IDBFactory();
  __resetStorageForTests();
  return globalThis.indexedDB;
}

function useBrowser(factory: IDBFactory): void {
  globalThis.indexedDB = factory;
  __resetStorageForTests();
}

describe("community MLS wrapper", () => {
  it("registers distinct device identities per browser", async () => {
    const nsA = newBrowser();
    const deviceA = (await ensureDevice()).device;

    const nsB = newBrowser();
    const deviceB = (await ensureDevice()).device;

    expect(deviceB.deviceId).not.toBe(deviceA.deviceId);
    expect(deviceA.keyPackageB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(deviceB.signaturePublicKeyB64).toMatch(/^[A-Za-z0-9+/=]+$/);

    // Same browser twice: stable identity (no re-keying).
    useBrowser(nsA);
    const again = await ensureDevice();
    expect(again.device.deviceId).toBe(deviceA.deviceId);
    expect(again.created).toBe(false);

    void nsB;
  });

  it("creates a group, adds a member via commit+welcome, and the joiner decrypts", async () => {
    // Browser B registers and publishes its key package.
    const nsB = newBrowser();
    const deviceB = (await ensureDevice()).device;

    // Browser A founds the channel group and adds B in one commit.
    const nsA = newBrowser();
    const deviceA = (await ensureDevice()).device;
    const setup = await createChannelGroup(COMMUNITY, CHANNEL, [
      {
        userId: "user-b",
        deviceId: deviceB.deviceId,
        keyPackageB64: deviceB.keyPackageB64,
      },
    ]);

    expect(setup.commit).not.toBeNull();
    expect(setup.commit?.ciphertextB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(setup.welcomes).toHaveLength(1);
    expect(setup.welcomes[0]?.recipientDeviceId).toBe(deviceB.deviceId);
    expect(setup.welcomes[0]?.ratchetTreeB64).toMatch(/^[A-Za-z0-9+/=]+$/);

    // A sends the first encrypted message (state advances and persists).
    const envelope = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "meet at the library",
    });
    expect(envelope).toMatch(/^[A-Za-z0-9+/=]+$/);

    // B joins with the addressed welcome + tree and decrypts A's message.
    useBrowser(nsB);
    const joined = await applyWelcome(COMMUNITY, CHANNEL, {
      id: "w-1",
      ciphertext: setup.welcomes[0]!.ciphertextB64,
      ratchet_tree: setup.welcomes[0]!.ratchetTreeB64,
      channel_id: CHANNEL,
    });
    expect(joined).toBe(true);

    const decrypted = await applyEnvelope(COMMUNITY, CHANNEL, {
      seq: 1,
      kind: "application",
      ciphertext: envelope,
    });
    expect(decrypted.payload).toEqual({
      v: 1,
      t: "text",
      body: "meet at the library",
    });

    // B replies; A decrypts the reply.
    const reply = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "on my way",
    });
    useBrowser(nsA);
    const replyDecrypted = await applyEnvelope(COMMUNITY, CHANNEL, {
      seq: 2,
      kind: "application",
      ciphertext: reply,
    });
    expect(replyDecrypted.payload).toEqual({
      v: 1,
      t: "text",
      body: "on my way",
    });

    // Welcome consumption is idempotent.
    useBrowser(nsB);
    const rejoined = await applyWelcome(COMMUNITY, CHANNEL, {
      id: "w-1",
      ciphertext: setup.welcomes[0]!.ciphertextB64,
      ratchet_tree: setup.welcomes[0]!.ratchetTreeB64,
      channel_id: CHANNEL,
    });
    expect(rejoined).toBe(false);

    // Both devices see each other in the ratchet tree.
    const idsA = await listGroupDeviceIds(COMMUNITY, CHANNEL);
    expect(idsA).toContain(deviceA.deviceId);
    expect(idsA).toContain(deviceB.deviceId);
  });

  it("rejects messages from after a device removal (epoch enforcement)", async () => {
    const nsB = newBrowser();
    const deviceB = (await ensureDevice()).device;

    const nsA = newBrowser();
    const setup = await createChannelGroup(COMMUNITY, CHANNEL, [
      {
        userId: "user-b",
        deviceId: deviceB.deviceId,
        keyPackageB64: deviceB.keyPackageB64,
      },
    ]);
    const welcome = setup.welcomes[0]!;

    const before = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "before the removal",
    });

    // B joins and reads the pre-removal message.
    useBrowser(nsB);
    await applyWelcome(COMMUNITY, CHANNEL, {
      id: "w-remove",
      ciphertext: welcome.ciphertextB64,
      ratchet_tree: welcome.ratchetTreeB64,
      channel_id: CHANNEL,
    });
    const ok = await applyEnvelope(COMMUNITY, CHANNEL, {
      seq: 1,
      kind: "application",
      ciphertext: before,
    });
    expect(ok.payload).toMatchObject({ body: "before the removal" });

    // A commits B's removal and sends a post-removal secret.
    useBrowser(nsA);
    const removal = await removeDeviceFromGroup(COMMUNITY, CHANNEL, deviceB.deviceId);
    expect(removal).not.toBeNull();
    const after = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "top-secret-after-removal",
    });

    // B still holds its pre-removal state. Applying the removal commit may
    // itself be rejected (self-removal); either way the post-removal
    // ciphertext MUST NOT decrypt — the epoch/key schedule forbids it.
    useBrowser(nsB);
    try {
      await applyEnvelope(COMMUNITY, CHANNEL, {
        seq: 2,
        kind: "commit",
        ciphertext: removal!.ciphertextB64,
      });
    } catch {
      // Applying a self-removal commit can legitimately fail; the security
      // property below does not depend on it succeeding.
    }
    await expect(
      applyEnvelope(COMMUNITY, CHANNEL, {
        seq: 3,
        kind: "application",
        ciphertext: after,
      }),
    ).rejects.toThrow();
  });

  it("self-removal (leave) deletes local group state", async () => {
    newBrowser();
    const device = (await ensureDevice()).device;
    const setup = await createChannelGroup(COMMUNITY, CHANNEL, []);
    expect(setup.commit).toBeNull();

    const memberIds = await listGroupDeviceIds(COMMUNITY, CHANNEL);
    expect(memberIds).toEqual([device.deviceId]);

    // The sent-message plaintext cache goes with the keys.
    await rememberOwnMessage({
      id: "client-leave",
      communityId: COMMUNITY,
      channelId: CHANNEL,
      payload: { v: 1, t: "text", body: "still here" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    expect(await recallOwnMessage("client-leave")).not.toBeNull();

    // ts-mls forbids a committer removing itself, so leaving is a local
    // teardown; the epoch advance is committed by a remaining member's
    // next sync (see removeDeviceFromGroup). Local keys must be gone.
    const commit = await removeSelfFromGroup(COMMUNITY, CHANNEL);
    expect(commit).toBeNull();
    expect(await loadGroup(COMMUNITY, CHANNEL)).toBeNull();
    expect(await recallOwnMessage("client-leave")).toBeNull();
  });

  it("community-wide local teardown clears every channel and the cache", async () => {
    newBrowser();
    await createChannelGroup(COMMUNITY, CHANNEL, []);
    const otherChannel = "33333333-3333-3333-3333-333333333333";
    await createChannelGroup(COMMUNITY, otherChannel, []);
    await rememberOwnMessage({
      id: "client-a",
      communityId: COMMUNITY,
      channelId: CHANNEL,
      payload: { v: 1, t: "text", body: "bye" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });

    const otherCommunity = "44444444-4444-4444-4444-444444444444";
    await createChannelGroup(otherCommunity, CHANNEL, []);
    await rememberOwnMessage({
      id: "client-other",
      communityId: otherCommunity,
      channelId: CHANNEL,
      payload: { v: 1, t: "text", body: "stay" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });

    await removeCommunityLocalState(COMMUNITY);

    expect(await loadGroup(COMMUNITY, CHANNEL)).toBeNull();
    expect(await loadGroup(COMMUNITY, otherChannel)).toBeNull();
    expect(await recallOwnMessage("client-a")).toBeNull();

    // Another community on the same device is untouched.
    expect(await loadGroup(otherCommunity, CHANNEL)).not.toBeNull();
    expect(await recallOwnMessage("client-other")).not.toBeNull();
  });

  it("adds a third device onto an existing group", async () => {
    newBrowser();
    const deviceB = (await ensureDevice()).device;

    const nsA = newBrowser();
    await createChannelGroup(COMMUNITY, CHANNEL, [
      {
        userId: "user-b",
        deviceId: deviceB.deviceId,
        keyPackageB64: deviceB.keyPackageB64,
      },
    ]);

    const nsC = newBrowser();
    const deviceC = (await ensureDevice()).device;

    useBrowser(nsA);
    const second = await addDevicesToGroup(COMMUNITY, CHANNEL, [
      {
        userId: "user-c",
        deviceId: deviceC.deviceId,
        keyPackageB64: deviceC.keyPackageB64,
      },
    ]);
    expect(second.commit).not.toBeNull();
    expect(second.welcomes).toHaveLength(1);
    expect(second.welcomes[0]?.recipientDeviceId).toBe(deviceC.deviceId);

    const ids = await listGroupDeviceIds(COMMUNITY, CHANNEL);
    expect(ids).toContain(deviceC.deviceId);
    expect(ids).toContain(deviceB.deviceId);

    // C joins and decrypts a message sent after its addition.
    const secret = await encryptForChannel(COMMUNITY, CHANNEL, {
      v: 1,
      t: "text",
      body: "three-body secret",
    });
    useBrowser(nsC);
    const joined = await applyWelcome(COMMUNITY, CHANNEL, {
      id: "w-c",
      ciphertext: second.welcomes[0]!.ciphertextB64,
      ratchet_tree: second.welcomes[0]!.ratchetTreeB64,
      channel_id: CHANNEL,
    });
    expect(joined).toBe(true);
    const decrypted = await applyEnvelope(COMMUNITY, CHANNEL, {
      seq: 5,
      kind: "application",
      ciphertext: secret,
    });
    expect(decrypted.payload).toMatchObject({ body: "three-body secret" });
  });
});
