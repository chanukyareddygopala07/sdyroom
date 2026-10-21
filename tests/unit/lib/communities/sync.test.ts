import { beforeEach, describe, expect, it, vi } from "vitest";

const mls = vi.hoisted(() => ({
  addDevicesToGroup: vi.fn(),
  applyWelcome: vi.fn(),
  createChannelGroup: vi.fn(),
  ensureDevice: vi.fn(),
  listGroupDeviceIds: vi.fn(),
  removeDeviceFromGroup: vi.fn(),
}));

const api = vi.hoisted(() => ({
  listWelcomesClient: vi.fn(),
  registerDeviceClient: vi.fn(),
  sendMessageClient: vi.fn(),
  sendWelcomeClient: vi.fn(),
  syncClient: vi.fn(),
}));

vi.mock("@/lib/crypto/mls", () => mls);
vi.mock("@/lib/communities/api", () => api);

import {
  canBootstrapGroup,
  ensureDeviceRegistered,
  MAX_ADDS_PER_SYNC,
  syncCommunity,
  type SyncContext,
} from "@/lib/communities/sync";

const COMMUNITY = "0b2f9c1e-3d4a-4b5c-8e6f-7a8b9c0d1e2f";
const CHANNEL = "1c3d0a2f-4e5b-4c6d-9f70-8b9c0d1e2f30";
const ME = "user-me";
const OTHER = "user-other";
const MY_DEVICE = "device-mine";
const THEIR_DEVICE = "device-theirs";

function context(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    communityId: COMMUNITY,
    userId: ME,
    isOwner: false,
    memberOrder: [
      { userId: OTHER, joinedAt: "2026-01-01T00:00:00Z" },
      { userId: ME, joinedAt: "2026-01-02T00:00:00Z" },
    ],
    ...overrides,
  };
}

type SyncData = {
  member_ids: string[];
  devices: Array<{ user_id: string; device_id: string; key_package: string }>;
};

function keyPackages(userIds: string[]): SyncData["devices"] {
  return userIds.map((user_id, index) => ({
    user_id,
    device_id: `device-${user_id}-${index}`,
    key_package: `kp-${user_id}-${index}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mls.ensureDevice.mockResolvedValue({
    device: { deviceId: MY_DEVICE },
    created: false,
  });
  mls.applyWelcome.mockResolvedValue(false);
  mls.removeDeviceFromGroup.mockResolvedValue(null);
  api.syncClient.mockResolvedValue({ member_ids: [], devices: [] });
  api.listWelcomesClient.mockResolvedValue({ welcomes: [] });
});

describe("canBootstrapGroup", () => {
  it("always lets the owner bootstrap", () => {
    expect(canBootstrapGroup(context({ isOwner: true }))).toBe(true);
  });

  it("gives the earliest-joined member the bootstrap right", () => {
    const first = context({ userId: OTHER });
    expect(canBootstrapGroup(first)).toBe(true);
    const later = context({ userId: ME });
    expect(canBootstrapGroup(later)).toBe(false);
  });

  it("breaks joined_at ties by user id (both founders converge)", () => {
    const at = "2026-01-01T00:00:00Z";
    const shared = {
      memberOrder: [
        { userId: "user-a", joinedAt: at },
        { userId: "user-b", joinedAt: at },
      ],
    };
    expect(canBootstrapGroup(context({ userId: "user-a", ...shared }))).toBe(true);
    expect(canBootstrapGroup(context({ userId: "user-b", ...shared }))).toBe(false);
  });

  it("never bootstraps a member with no order entry", () => {
    expect(canBootstrapGroup(context({ memberOrder: [] }))).toBe(false);
  });
});

describe("ensureDeviceRegistered", () => {
  it("publishes the key package exactly once, on device creation", async () => {
    mls.ensureDevice.mockResolvedValue({
      device: { deviceId: MY_DEVICE, keyPackageB64: "kp", signaturePublicKeyB64: "sig" },
      created: true,
    });
    await expect(ensureDeviceRegistered()).resolves.toEqual({
      deviceId: MY_DEVICE,
    });
    expect(api.registerDeviceClient).toHaveBeenCalledWith({
      deviceId: MY_DEVICE,
      keyPackage: "kp",
      signaturePublicKey: "sig",
    });

    mls.ensureDevice.mockResolvedValue({
      device: { deviceId: MY_DEVICE, keyPackageB64: "kp", signaturePublicKeyB64: "sig" },
      created: false,
    });
    api.registerDeviceClient.mockClear();
    await ensureDeviceRegistered();
    expect(api.registerDeviceClient).not.toHaveBeenCalled();
  });
});

describe("syncCommunity", () => {
  it("waits when there is no group state and this client is not the founder", async () => {
    mls.listGroupDeviceIds.mockResolvedValue(null);
    const summary = await syncCommunity(context(), [CHANNEL]);
    expect(summary.deviceId).toBe(MY_DEVICE);
    expect(summary.channels).toEqual([
      { channelId: CHANNEL, action: "waiting", addedCount: 0, removedCount: 0 },
    ]);
    expect(mls.createChannelGroup).not.toHaveBeenCalled();
  });

  it("bootstraps as the founder: adds every other device, posts commit + welcomes", async () => {
    const devices = [
      { user_id: ME, device_id: MY_DEVICE, key_package: "kp-me" },
      ...keyPackages([OTHER]),
    ];
    api.syncClient.mockResolvedValue({
      member_ids: [ME, OTHER],
      devices,
    });
    mls.listGroupDeviceIds.mockResolvedValue(null);
    mls.createChannelGroup.mockResolvedValue({
      commit: { ciphertextB64: "commit-b64", clientMsgId: "cm-1" },
      welcomes: [
        {
          recipientUserId: OTHER,
          recipientDeviceId: devices[1]!.device_id,
          ciphertextB64: "welcome-b64",
          ratchetTreeB64: "tree-b64",
          clientMsgId: "cm-2",
        },
      ],
    });

    const summary = await syncCommunity(context({ isOwner: true }), [CHANNEL]);

    expect(summary.channels[0]).toEqual({
      channelId: CHANNEL,
      action: "bootstrapped",
      addedCount: 1,
      removedCount: 0,
    });
    // The founder's own device is never an add target.
    expect(mls.createChannelGroup).toHaveBeenCalledWith(COMMUNITY, CHANNEL, [
      {
        userId: OTHER,
        deviceId: devices[1]!.device_id,
        keyPackageB64: "kp-user-other-0",
      },
    ]);
    expect(api.sendMessageClient).toHaveBeenCalledWith(COMMUNITY, CHANNEL, {
      kind: "commit",
      ciphertext: "commit-b64",
      clientMsgId: "cm-1",
      senderDeviceId: MY_DEVICE,
    });
    expect(api.sendWelcomeClient).toHaveBeenCalledWith(COMMUNITY, CHANNEL, {
      ciphertext: "welcome-b64",
      ratchetTree: "tree-b64",
      clientMsgId: "cm-2",
      recipientUserId: OTHER,
      recipientDeviceId: devices[1]!.device_id,
    });
  });

  it("adds missing devices onto an existing tree, skipping in-tree and own devices", async () => {
    const devices = [
      { user_id: ME, device_id: MY_DEVICE, key_package: "kp-me" },
      { user_id: OTHER, device_id: THEIR_DEVICE, key_package: "kp-them" },
    ];
    api.syncClient.mockResolvedValue({ member_ids: [ME, OTHER], devices });
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE]);
    mls.addDevicesToGroup.mockResolvedValue({
      commit: { ciphertextB64: "commit-b64", clientMsgId: "cm-1" },
      welcomes: [],
    });

    const summary = await syncCommunity(context(), [CHANNEL]);

    expect(summary.channels[0]).toMatchObject({
      action: "added",
      addedCount: 1,
    });
    expect(mls.addDevicesToGroup).toHaveBeenCalledWith(COMMUNITY, CHANNEL, [
      { userId: OTHER, deviceId: THEIR_DEVICE, keyPackageB64: "kp-them" },
    ]);

    // Everyone present in the tree already: nothing to do.
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE, THEIR_DEVICE]);
    mls.addDevicesToGroup.mockClear();
    api.sendMessageClient.mockClear();
    const inSync = await syncCommunity(context(), [CHANNEL]);
    expect(inSync.channels[0]).toMatchObject({ action: "in-sync" });
    expect(mls.addDevicesToGroup).not.toHaveBeenCalled();
  });

  it("caps adds per run so a big community converges over several visits", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      user_id: `u${String(i).padStart(2, "0")}`,
      device_id: `d${i}`,
      key_package: `kp${i}`,
    }));
    api.syncClient.mockResolvedValue({
      member_ids: many.map((d) => d.user_id),
      devices: many,
    });
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE]);
    mls.addDevicesToGroup.mockResolvedValue({
      commit: { ciphertextB64: "c", clientMsgId: "cm" },
      welcomes: [],
    });

    const summary = await syncCommunity(context(), [CHANNEL]);
    expect(mls.addDevicesToGroup).toHaveBeenCalledTimes(1);
    const targets = mls.addDevicesToGroup.mock.calls[0]![2] as unknown[];
    expect(targets).toHaveLength(MAX_ADDS_PER_SYNC);
    expect(summary.channels[0]).toMatchObject({
      action: "added",
      addedCount: MAX_ADDS_PER_SYNC,
    });
  });

  it("removes devices that no active member still holds (ban/kick/leave)", async () => {
    const devices = [{ user_id: ME, device_id: MY_DEVICE, key_package: "kp-me" }];
    api.syncClient.mockResolvedValue({ member_ids: [ME], devices });
    // The tree still holds THEIR_DEVICE even though it is no longer active.
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE, THEIR_DEVICE]);
    mls.removeDeviceFromGroup.mockResolvedValue({
      ciphertextB64: "removal-commit",
      clientMsgId: "cm-rm",
    });

    const summary = await syncCommunity(context({ isOwner: false, memberOrder: [{ userId: ME, joinedAt: "2026-01-01T00:00:00Z" }] }), [CHANNEL]);

    expect(summary.channels[0]).toEqual({
      channelId: CHANNEL,
      action: "removed",
      addedCount: 0,
      removedCount: 1,
    });
    expect(mls.removeDeviceFromGroup).toHaveBeenCalledWith(
      COMMUNITY,
      CHANNEL,
      THEIR_DEVICE,
    );
    expect(api.sendMessageClient).toHaveBeenCalledWith(COMMUNITY, CHANNEL, {
      kind: "commit",
      ciphertext: "removal-commit",
      clientMsgId: "cm-rm",
      senderDeviceId: MY_DEVICE,
    });
  });

  it("never removes its own device even when it looks stale", async () => {
    api.syncClient.mockResolvedValue({
      member_ids: [ME],
      devices: [{ user_id: ME, device_id: MY_DEVICE, key_package: "kp" }],
    });
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE]);
    mls.removeDeviceFromGroup.mockResolvedValue({
      ciphertextB64: "x",
      clientMsgId: "cm",
    });

    const summary = await syncCommunity(
      context({ memberOrder: [{ userId: ME, joinedAt: "2026-01-01T00:00:00Z" }] }),
      [CHANNEL],
    );
    expect(mls.removeDeviceFromGroup).not.toHaveBeenCalled();
    expect(summary.channels[0]).toMatchObject({ action: "in-sync" });
  });

  it("consumes only welcomes addressed to this device and reports 'joined'", async () => {
    const welcome = {
      id: "w1",
      ciphertext: "c",
      ratchet_tree: "t",
      channel_id: CHANNEL,
      recipient_device_id: MY_DEVICE,
    };
    const otherDeviceWelcome = { ...welcome, id: "w2", recipient_device_id: "device-someone-else" };
    api.listWelcomesClient.mockResolvedValue({
      welcomes: [otherDeviceWelcome, welcome],
    });
    api.syncClient.mockResolvedValue({
      member_ids: [ME],
      devices: [{ user_id: ME, device_id: MY_DEVICE, key_package: "kp" }],
    });
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE]);
    mls.applyWelcome.mockResolvedValue(true);

    const summary = await syncCommunity(
      context({ memberOrder: [{ userId: ME, joinedAt: "2026-01-01T00:00:00Z" }] }),
      [CHANNEL],
    );

    expect(mls.applyWelcome).toHaveBeenCalledTimes(1);
    expect(mls.applyWelcome).toHaveBeenCalledWith(COMMUNITY, CHANNEL, welcome);
    expect(summary.channels[0]).toMatchObject({ action: "joined" });
  });

  it("filters welcomes to the channel being synced", async () => {
    api.listWelcomesClient.mockResolvedValue({
      welcomes: [
        {
          id: "w-other-channel",
          ciphertext: "c",
          ratchet_tree: "t",
          channel_id: "another-channel",
          recipient_device_id: MY_DEVICE,
        },
      ],
    });
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE]);
    api.syncClient.mockResolvedValue({
      member_ids: [ME],
      devices: [{ user_id: ME, device_id: MY_DEVICE, key_package: "kp" }],
    });

    await syncCommunity(
      context({ memberOrder: [{ userId: ME, joinedAt: "2026-01-01T00:00:00Z" }] }),
      [CHANNEL],
    );
    expect(mls.applyWelcome).not.toHaveBeenCalled();
  });

  it("reports a channel whose crypto failed as 'waiting' instead of throwing", async () => {
    api.syncClient.mockResolvedValue({
      member_ids: [ME],
      devices: [{ user_id: ME, device_id: MY_DEVICE, key_package: "kp" }],
    });
    mls.listGroupDeviceIds.mockRejectedValue(new Error("epoch drift"));

    const summary = await syncCommunity(context(), [CHANNEL, "second-channel"]);
    expect(summary.channels).toEqual([
      { channelId: CHANNEL, action: "waiting", addedCount: 0, removedCount: 0 },
      {
        channelId: "second-channel",
        action: "waiting",
        addedCount: 0,
        removedCount: 0,
      },
    ]);
    // One failure must not stop the remaining channels from syncing.
    expect(mls.listGroupDeviceIds).toHaveBeenCalledTimes(2);
  });

  it("prefers reporting 'added' when a run both adds and removes", async () => {
    // Tree: mine + a stale device. Active: mine + a freshly registered one.
    mls.listGroupDeviceIds.mockResolvedValue([MY_DEVICE, "device-stale"]);
    api.syncClient.mockResolvedValue({
      member_ids: [ME],
      devices: [
        { user_id: ME, device_id: MY_DEVICE, key_package: "kp" },
        { user_id: ME, device_id: "device-new", key_package: "kp2" },
      ],
    });
    mls.addDevicesToGroup.mockResolvedValue({
      commit: { ciphertextB64: "c", clientMsgId: "cm" },
      welcomes: [],
    });
    mls.removeDeviceFromGroup.mockResolvedValue({
      ciphertextB64: "rm",
      clientMsgId: "cm-rm",
    });

    const summary = await syncCommunity(
      context({ memberOrder: [{ userId: ME, joinedAt: "2026-01-01T00:00:00Z" }] }),
      [CHANNEL],
    );
    expect(summary.channels[0]).toMatchObject({
      action: "added",
      addedCount: 1,
      removedCount: 1,
    });
    expect(mls.removeDeviceFromGroup).toHaveBeenCalledWith(
      COMMUNITY,
      CHANNEL,
      "device-stale",
    );
  });
});
