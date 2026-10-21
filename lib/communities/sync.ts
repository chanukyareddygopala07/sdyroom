/**
 * MLS membership synchronization for community channels.
 *
 * The server stores ciphertext and public key packages; it cannot add
 * members to anyone's group. Membership changes are therefore driven by
 * member CLIENTS, deterministically:
 *
 * 1. Every client registers its own device (key package) once per browser.
 * 2. On channel open (and after join/approve), the client fetches
 *    `/api/communities/[id]/sync` — active member ids + their key packages.
 * 3. For each channel the client compares active members' devices against
 *    the channel group's ratchet tree and:
 *    - ADDs missing devices (one commit + addressed welcomes per run);
 *    - REMOVEs devices that are no longer active members (ban/kick/leave);
 *    - BOOTSTRAPS the group when none exists, but only for a deterministic
 *      founder: the owner, or failing that the earliest-joined active
 *      member (ties broken by user id). Everyone else waits for a welcome.
 *
 * Bounded work: at most `MAX_ADDS_PER_SYNC` devices are added per channel
 * per run so a large community converges over a few visits instead of one
 * rate-limited burst. All steps are idempotent — a device already in the
 * tree is skipped by identity match, and welcome consumption is recorded.
 */

import {
  addDevicesToGroup,
  applyWelcome,
  createChannelGroup,
  ensureDevice,
  listGroupDeviceIds,
  removeDeviceFromGroup,
  type AddTarget,
} from "@/lib/crypto/mls";
import {
  listWelcomesClient,
  registerDeviceClient,
  sendMessageClient,
  sendWelcomeClient,
  syncClient,
} from "@/lib/communities/api";

/** Devices added per channel per sync run — stays under the 30/60s send cap. */
export const MAX_ADDS_PER_SYNC = 8;

export type SyncContext = {
  communityId: string;
  userId: string;
  isOwner: boolean;
  /** Active members ordered by joined_at asc, then user_id asc. */
  memberOrder: Array<{ userId: string; joinedAt: string }>;
};

export type ChannelSyncSummary = {
  channelId: string;
  action:
    | "bootstrapped"
    | "added"
    | "removed"
    | "joined"
    | "waiting"
    | "in-sync";
  addedCount: number;
  removedCount: number;
};

export type SyncSummary = {
  deviceId: string;
  channels: ChannelSyncSummary[];
};

/** Deterministic founder: the owner, else the earliest-joined active member. */
export function canBootstrapGroup(
  context: SyncContext,
): boolean {
  if (context.isOwner) {
    return true;
  }
  const first = [...context.memberOrder].sort(
    (a, b) =>
      a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId),
  )[0];
  return first?.userId === context.userId;
}

/** Ensure this browser has a device and its key package is published. */
export async function ensureDeviceRegistered(): Promise<{ deviceId: string }> {
  const { device, created } = await ensureDevice();
  if (created) {
    await registerDeviceClient({
      deviceId: device.deviceId,
      keyPackage: device.keyPackageB64,
      signaturePublicKey: device.signaturePublicKeyB64,
    });
  }
  return { deviceId: device.deviceId };
}

type SyncDevice = { user_id: string; device_id: string; key_package: string };

/**
 * Run the full sync for one community. Never throws for partial failures:
 * each channel reports what happened; a channel that failed crypto is
 * reported with `action: "waiting"` and retried on the next run.
 */
export async function syncCommunity(
  context: SyncContext,
  channelIds: string[],
): Promise<SyncSummary> {
  const { deviceId } = await ensureDeviceRegistered();

  const [syncData, welcomePage] = await Promise.all([
    syncClient(context.communityId),
    listWelcomesClient(context.communityId),
  ]);

  const devicesByUser = new Map<string, SyncDevice[]>();
  for (const device of syncData.devices) {
    const list = devicesByUser.get(device.user_id) ?? [];
    list.push(device);
    devicesByUser.set(device.user_id, list);
  }

  const activeMemberIds = new Set(syncData.member_ids);
  const channels: ChannelSyncSummary[] = [];

  for (const channelId of channelIds) {
    try {
      const summary = await syncChannel(context, {
        channelId,
        deviceId,
        devicesByUser,
        activeMemberIds,
        welcomes: welcomePage.welcomes.filter((w) => w.channel_id === channelId),
      });
      channels.push(summary);
    } catch {
      channels.push({
        channelId,
        action: "waiting",
        addedCount: 0,
        removedCount: 0,
      });
    }
  }

  return { deviceId, channels };
}

async function syncChannel(
  context: SyncContext,
  args: {
    channelId: string;
    deviceId: string;
    devicesByUser: Map<string, SyncDevice[]>;
    activeMemberIds: Set<string>;
    welcomes: Array<{
      id: string;
      ciphertext: string;
      ratchet_tree: string;
      channel_id: string;
      recipient_device_id: string;
    }>;
  },
): Promise<ChannelSyncSummary> {
  const { communityId } = context;
  const { channelId } = args;

  // 1. Consume any welcomes addressed to this device.
  let joinedViaWelcome = false;
  for (const welcome of args.welcomes) {
    if (welcome.recipient_device_id !== args.deviceId) {
      continue;
    }
    const applied = await applyWelcome(communityId, channelId, welcome);
    if (applied) {
      joinedViaWelcome = true;
    }
  }

  // 2. Compare the tree against active members' devices.
  const treeIds = await listGroupDeviceIds(communityId, channelId);

  if (treeIds === null) {
    // No local state: bootstrap only if this client is the deterministic
    // founder; otherwise wait for a welcome from a member.
    if (!canBootstrapGroup(context)) {
      return {
        channelId,
        action: "waiting",
        addedCount: 0,
        removedCount: 0,
      };
    }
    const targets = collectMissingTargets(context, args, null).slice(
      0,
      MAX_ADDS_PER_SYNC,
    );
    const setup = await createChannelGroup(communityId, channelId, targets);
    await postSetup(context.communityId, channelId, setup);
    return {
      channelId,
      action: "bootstrapped",
      addedCount: targets.length,
      removedCount: 0,
    };
  }

  const tree = new Set(treeIds);
  const missing = collectMissingTargets(context, args, tree).slice(
    0,
    MAX_ADDS_PER_SYNC,
  );

  // A tree device is stale when no ACTIVE member has registered it: the
  // account was banned, kicked, or left (and a remaining member's client is
  // the one that can produce the cryptographic removal). The committer's
  // own device is never removed by itself.
  const activeDeviceIds = new Set<string>();
  for (const userId of args.activeMemberIds) {
    for (const device of args.devicesByUser.get(userId) ?? []) {
      activeDeviceIds.add(device.device_id);
    }
  }
  const stale = [...tree].filter(
    (treeDeviceId) =>
      treeDeviceId !== args.deviceId && !activeDeviceIds.has(treeDeviceId),
  );

  let addedCount = 0;
  let removedCount = 0;

  if (missing.length > 0) {
    const setup = await addDevicesToGroup(communityId, channelId, missing);
    await postSetup(communityId, channelId, setup);
    addedCount = missing.length;
  }

  // Remove stale devices one commit each (small N in practice).
  for (const staleDeviceId of stale.slice(0, MAX_ADDS_PER_SYNC)) {
    const removal = await removeDeviceFromGroup(communityId, channelId, staleDeviceId);
    if (removal) {
      await sendMessageClient(communityId, channelId, {
        kind: "commit",
        ciphertext: removal.ciphertextB64,
        clientMsgId: removal.clientMsgId,
        senderDeviceId: args.deviceId,
      });
      removedCount += 1;
    }
  }

  if (addedCount > 0) {
    return { channelId, action: "added", addedCount, removedCount };
  }
  if (removedCount > 0) {
    return { channelId, action: "removed", addedCount, removedCount };
  }
  if (joinedViaWelcome) {
    return { channelId, action: "joined", addedCount: 0, removedCount: 0 };
  }
  return { channelId, action: "in-sync", addedCount: 0, removedCount: 0 };
}

function collectMissingTargets(
  context: SyncContext,
  args: {
    devicesByUser: Map<string, SyncDevice[]>;
    activeMemberIds: Set<string>;
    deviceId: string;
  },
  tree: Set<string> | null,
): AddTarget[] {
  const targets: AddTarget[] = [];
  for (const userId of args.activeMemberIds) {
    for (const device of args.devicesByUser.get(userId) ?? []) {
      if (device.device_id === args.deviceId) {
        continue;
      }
      if (tree?.has(device.device_id)) {
        continue;
      }
      targets.push({
        userId,
        deviceId: device.device_id,
        keyPackageB64: device.key_package,
      });
    }
  }
  // Deterministic order so concurrent founders converge on the same adds.
  targets.sort(
    (a, b) => a.userId.localeCompare(b.userId) || a.deviceId.localeCompare(b.deviceId),
  );
  return targets;
}

async function postSetup(
  communityId: string,
  channelId: string,
  setup: { commit: { ciphertextB64: string; clientMsgId: string } | null; welcomes: Array<{
    recipientUserId: string;
    recipientDeviceId: string;
    ciphertextB64: string;
    ratchetTreeB64: string;
    clientMsgId: string;
  }> },
): Promise<void> {
  if (setup.commit) {
    // Bootstrap posts the commit; add-runs post it too. Sent before welcomes
    // so a crash between the two leaves welcomes unreferenced rather than a
    // commit that nobody in the group can verify... actually the reverse
    // matters more: members must see the commit in history before they try
    // to use the new epoch, and the joiner needs the welcome regardless.
    await sendMessageClient(communityId, channelId, {
      kind: "commit",
      ciphertext: setup.commit.ciphertextB64,
      clientMsgId: setup.commit.clientMsgId,
      senderDeviceId: (await ensureDevice()).device.deviceId,
    });
  }
  for (const welcome of setup.welcomes) {
    await sendWelcomeClient(communityId, channelId, {
      ciphertext: welcome.ciphertextB64,
      ratchetTree: welcome.ratchetTreeB64,
      clientMsgId: welcome.clientMsgId,
      recipientUserId: welcome.recipientUserId,
      recipientDeviceId: welcome.recipientDeviceId,
    });
  }
}
