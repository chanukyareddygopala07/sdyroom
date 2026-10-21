/**
 * MLS (RFC 9420) wrapper for community channels, built on `ts-mls`.
 *
 * This module is CLIENT-ONLY: it runs in the browser (and in vitest), holds
 * private keys in IndexedDB via `lib/crypto/storage.ts`, and is never
 * imported by server code. The server sees only opaque base64 envelopes.
 *
 * Wire rules (verified against ts-mls 1.6.4 and easy to get wrong):
 * - Every MLS artifact crosses the boundary as `encodeMlsMessage(obj)`
 *   bytes and is decoded exactly once with `decodeMlsMessage(bytes, 0)[0]`.
 *   Re-encoding an already-encoded/decoded object corrupts it — the encoder
 *   is not idempotent.
 * - Commits are encoded BEFORE adopting `newState` as the sending state.
 * - A welcome needs the group's ratchet tree out-of-band (RFC 9420
 *   distribution); both travel on the same addressed welcome row.
 * - After `decodeGroupState`, `clientConfig` must be reattached from the
 *   library's five defaults (it is not part of the serialized state).
 *
 * Protocol-level security properties were validated end-to-end before this
 * wrapper was written: membership commits advance the epoch, a removed
 * member's restored state rejects future messages with a CryptoError, and
 * no operation leaks plaintext to the caller who cannot already decrypt.
 * See docs/SECURITY.md for the honest limits (ts-mls has had no formal
 * audit; the server necessarily sees metadata).
 */

import {
  createApplicationMessage,
  createCommit,
  createGroup,
  joinGroup,
  processPrivateMessage,
  processPublicMessage,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultKeyPackageEqualityConfig,
  defaultPaddingConfig,
  defaultAuthenticationService,
  generateKeyPackage,
  encodeMlsMessage,
  decodeMlsMessage,
  encodeGroupState,
  decodeGroupState,
  zeroOutUint8Array,
  type ClientState,
  type CiphersuiteImpl,
  type KeyPackage,
  type Proposal,
} from "ts-mls";
import { b64ToBytes, bytesToB64 } from "@/lib/crypto/base64";
import {
  isWelcomeConsumed,
  loadDevice,
  loadGroup,
  markWelcomeConsumed,
  saveDevice,
  saveGroup,
  deleteGroup,
  forgetOwnMessagesForChannel,
  forgetOwnMessagesForCommunity,
  listGroupsForCommunity,
  type StoredDevice,
} from "@/lib/crypto/storage";

/** Ciphersuite: X25519 + AES-128-GCM + Ed25519, no WASM dependencies. */
export const COMMUNITY_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

const SUITE_NAME = getCiphersuiteFromName(COMMUNITY_CIPHERSUITE);

let implPromise: Promise<CiphersuiteImpl> | null = null;

function getImpl(): Promise<CiphersuiteImpl> {
  if (!implPromise) {
    implPromise = getCiphersuiteImpl(SUITE_NAME);
  }
  return implPromise;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** First decoded value or a hard failure — decoders never legitimately return empty. */
function decodedFirst<T>(result: [T, number] | undefined): T {
  if (!result) {
    throw new Error("MLS decode produced no value.");
  }
  return result[0];
}

/** Reattach the config that `decodeGroupState` cannot carry. */
function restoreState(stateB64: string): ClientState {
  const state = decodedFirst(decodeGroupState(b64ToBytes(stateB64), 0)) as ClientState;
  state.clientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
  };
  return state;
}

function encodeState(state: ClientState): string {
  return bytesToB64(encodeGroupState(state));
}

export type DeviceIdentity = {
  deviceId: string;
  keyPackageB64: string;
  signaturePublicKeyB64: string;
};

export type AddTarget = {
  userId: string;
  deviceId: string;
  /** base64 MLS key package from `/api/communities/devices/fetch`. */
  keyPackageB64: string;
};

export type WelcomeEnvelope = {
  recipientUserId: string;
  recipientDeviceId: string;
  /** base64 MLS welcome message. */
  ciphertextB64: string;
  /** base64 ratchet-tree snapshot needed to join. */
  ratchetTreeB64: string;
  clientMsgId: string;
};

export type CommitEnvelope = {
  /** base64 public MLS commit message. */
  ciphertextB64: string;
  clientMsgId: string;
};

export type GroupSetupResult = {
  commit: CommitEnvelope | null;
  welcomes: WelcomeEnvelope[];
};

function newMsgId(): string {
  return crypto.randomUUID();
}

function decodeKeyPackageMessage(b64: string): KeyPackage {
  const decoded = decodedFirst(decodeMlsMessage(b64ToBytes(b64), 0));
  if (decoded.wireformat !== "mls_key_package") {
    throw new Error("Expected a key package message.");
  }
  return decoded.keyPackage;
}

/** Device id carried in a basic credential; null for other credential types. */
function credentialIdentityOrNull(credential: {
  credentialType: string;
  identity?: Uint8Array;
}): string | null {
  if (credential.credentialType === "basic" && credential.identity) {
    return decoder.decode(credential.identity);
  }
  return null;
}

function leafIndexOfIdentity(state: ClientState, identity: string): number | null {
  for (let i = 0; i < state.ratchetTree.length; i += 1) {
    const node = state.ratchetTree[i];
    if (node?.nodeType !== "leaf" || !node.leaf?.credential) {
      continue;
    }
    if (credentialIdentityOrNull(node.leaf.credential) === identity) {
      return i / 2;
    }
  }
  return null;
}

/** All leaf identities currently in the group, excluding blank leaves. */
export function groupMemberDeviceIds(state: ClientState): string[] {
  const ids: string[] = [];
  for (let i = 0; i < state.ratchetTree.length; i += 1) {
    const node = state.ratchetTree[i];
    if (node?.nodeType === "leaf" && node.leaf?.credential) {
      const identity = credentialIdentityOrNull(node.leaf.credential);
      if (identity !== null) {
        ids.push(identity);
      }
    }
  }
  return ids;
}

/**
 * Get (or lazily create) this browser's device identity. The private key
 * package is generated once and stored only in IndexedDB.
 */
export async function ensureDevice(): Promise<{
  device: StoredDevice;
  created: boolean;
}> {
  const existing = await loadDevice();
  if (existing) {
    return { device: existing, created: false };
  }

  const impl = await getImpl();
  const deviceId = crypto.randomUUID();
  const { publicPackage, privatePackage } = await generateKeyPackage(
    { credentialType: "basic", identity: encoder.encode(deviceId) },
    defaultCapabilities(),
    defaultLifetime,
    [],
    impl,
  );

  const device: StoredDevice = {
    id: "current",
    deviceId,
    keyPackageB64: bytesToB64(
      encodeMlsMessage({
        keyPackage: publicPackage,
        wireformat: "mls_key_package",
        version: "mls10",
      }),
    ),
    privatePackageB64: bytesToB64(encodeKeyPackagePrivate(privatePackage)),
    signaturePublicKeyB64: bytesToB64(publicPackage.leafNode.signaturePublicKey),
    createdAt: new Date().toISOString(),
  };
  await saveDevice(device);
  return { device, created: true };
}

/**
 * Serialize the private key package as three dot-separated base64 fields
 * (init, hpke, signature). Field lengths differ — the signature private key
 * is PKCS8 (~48 bytes) while the others are 32 raw bytes — so a fixed-width
 * split would corrupt them.
 */
function encodeKeyPackagePrivate(pkg: {
  initPrivateKey: Uint8Array;
  hpkePrivateKey: Uint8Array;
  signaturePrivateKey: Uint8Array;
}): Uint8Array {
  const joined = [
    bytesToB64(pkg.initPrivateKey),
    bytesToB64(pkg.hpkePrivateKey),
    bytesToB64(pkg.signaturePrivateKey),
  ].join(".");
  return encoder.encode(joined);
}

function decodeKeyPackagePrivate(b64: string): {
  initPrivateKey: Uint8Array;
  hpkePrivateKey: Uint8Array;
  signaturePrivateKey: Uint8Array;
} {
  const parts = decoder.decode(b64ToBytes(b64)).split(".");
  if (parts.length !== 3) {
    throw new Error("Stored private key package is corrupt.");
  }
  return {
    initPrivateKey: b64ToBytes(parts[0]!),
    hpkePrivateKey: b64ToBytes(parts[1]!),
    signaturePrivateKey: b64ToBytes(parts[2]!),
  };
}

function decodeOwnKeyPackage(device: StoredDevice): KeyPackage {
  const decoded = decodedFirst(decodeMlsMessage(b64ToBytes(device.keyPackageB64), 0));
  if (decoded.wireformat !== "mls_key_package") {
    throw new Error("Stored key package has the wrong wire format.");
  }
  return decoded.keyPackage;
}

async function loadOwnState(
  communityId: string,
  channelId: string,
): Promise<{ state: ClientState; lastAppliedSeq: number } | null> {
  const stored = await loadGroup(communityId, channelId);
  if (!stored) {
    return null;
  }
  return {
    state: restoreState(stored.stateB64),
    lastAppliedSeq: stored.lastAppliedSeq,
  };
}

async function persistState(
  communityId: string,
  channelId: string,
  state: ClientState,
  lastAppliedSeq: number,
): Promise<void> {
  await saveGroup({
    id: `${communityId}:${channelId}`,
    communityId,
    channelId,
    stateB64: encodeState(state),
    lastAppliedSeq,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Create the channel's first group state: this device becomes the founding
 * member, optionally adding other devices in the same commit. Returns the
 * commit + welcomes to POST (empty when this device is alone).
 */
export async function createChannelGroup(
  communityId: string,
  channelId: string,
  adds: AddTarget[],
): Promise<GroupSetupResult> {
  const { device } = await ensureDevice();
  const impl = await getImpl();
  const publicPackage = decodeOwnKeyPackage(device);
  const privatePackage = decodeKeyPackagePrivate(device.privatePackageB64);

  let state = await createGroup(
    encoder.encode(channelId),
    publicPackage,
    privatePackage,
    [],
    impl,
  );

  if (adds.length === 0) {
    await persistState(communityId, channelId, state, 0);
    return { commit: null, welcomes: [] };
  }

  const proposals: Proposal[] = adds.map((target) => ({
    proposalType: "add",
    add: {
      keyPackage: decodeKeyPackageMessage(target.keyPackageB64),
    },
  }));

  const result = await createCommit(
    { state, cipherSuite: impl },
    { wireAsPublicMessage: true, extraProposals: proposals },
  );
  if (!result.welcome) {
    throw new Error("Commit produced no welcome message.");
  }

  const commitB64 = bytesToB64(encodeMlsMessage(result.commit));
  const welcomeB64 = bytesToB64(
    encodeMlsMessage({
      welcome: result.welcome,
      wireformat: "mls_welcome",
      version: "mls10",
    }),
  );
  // Joiners need the tree as of the commit that adds them: the new state.
  const treeB64 = bytesToB64(encodeTreeCarrier(result.newState));

  state = result.newState;
  await persistState(communityId, channelId, state, 0);

  return {
    commit: { ciphertextB64: commitB64, clientMsgId: newMsgId() },
    welcomes: adds.map((target) => ({
      recipientUserId: target.userId,
      recipientDeviceId: target.deviceId,
      ciphertextB64: welcomeB64,
      ratchetTreeB64: treeB64,
      clientMsgId: newMsgId(),
    })),
  };
}

/**
 * Add devices to an existing group. One commit adds all of them; the single
 * resulting welcome is fanned out to each added device's addressed row.
 */
export async function addDevicesToGroup(
  communityId: string,
  channelId: string,
  adds: AddTarget[],
): Promise<GroupSetupResult> {
  const loaded = await loadOwnState(communityId, channelId);
  if (!loaded) {
    throw new Error("No local group state for this channel yet.");
  }
  await ensureDeviceOrThrow();
  const impl = await getImpl();

  const proposals: Proposal[] = adds.map((target) => ({
    proposalType: "add",
    add: {
      keyPackage: decodeKeyPackageMessage(target.keyPackageB64),
    },
  }));

  const result = await createCommit(
    { state: loaded.state, cipherSuite: impl },
    { wireAsPublicMessage: true, extraProposals: proposals },
  );
  if (!result.welcome) {
    throw new Error("Commit produced no welcome message.");
  }

  const commitB64 = bytesToB64(encodeMlsMessage(result.commit));
  const welcomeB64 = bytesToB64(
    encodeMlsMessage({
      welcome: result.welcome,
      wireformat: "mls_welcome",
      version: "mls10",
    }),
  );
  // Joiners need the tree as of the commit that adds them: the new state.
  const treeB64 = bytesToB64(encodeTreeCarrier(result.newState));

  await persistState(
    communityId,
    channelId,
    result.newState,
    loaded.lastAppliedSeq,
  );

  return {
    commit: { ciphertextB64: commitB64, clientMsgId: newMsgId() },
    welcomes: adds.map((target) => ({
      recipientUserId: target.userId,
      recipientDeviceId: target.deviceId,
      ciphertextB64: welcomeB64,
      ratchetTreeB64: treeB64,
      clientMsgId: newMsgId(),
    })),
  };
}

/**
 * Tear down this device's local state for a channel (leave flow).
 *
 * RFC 9420 permits self-removal commits, but ts-mls 1.6.4 rejects a Commit
 * whose committer removes itself ("Commit cannot contain a remove proposal
 * removing committer"), so the leaving client cannot produce the epoch
 * advance itself. Instead:
 * 1. The leave API revokes RLS/API access immediately — the device can no
 *    longer fetch any new ciphertext.
 * 2. This function deletes the local keys (and this device's sent-message
 *    plaintext cache), so this device cannot decrypt anything it
 *    re-encounters either.
 * 3. The next remaining member's client sync runs `removeDeviceFromGroup`
 *    for the departed device, advancing the epoch for everyone still in.
 *
 * The honest gap (documented in docs/SECURITY.md): until step 3 lands, the
 * departed device's OLD keys could decrypt NEW ciphertext if a colluding
 * member handed it over out-of-band. API/RLS revocation is immediate; the
 * cryptographic transition completes on the next member sync.
 */
export async function removeSelfFromGroup(
  communityId: string,
  channelId: string,
): Promise<null> {
  await deleteGroup(communityId, channelId);
  await forgetOwnMessagesForChannel(channelId);
  return null;
}

/**
 * Full local teardown for a community: every channel's group state plus the
 * sent-message plaintext cache (see `lib/crypto/storage.ts`). The leave and
 * delete flows call this AFTER the API revokes server-side access, so a
 * failure here can only leave stale local data, never restore access.
 */
export async function removeCommunityLocalState(
  communityId: string,
): Promise<null> {
  const groups = await listGroupsForCommunity(communityId);
  for (const group of groups) {
    await deleteGroup(group.communityId, group.channelId);
  }
  await forgetOwnMessagesForCommunity(communityId);
  return null;
}

/** Commit the removal of another device (ban/kick sync). */
export async function removeDeviceFromGroup(
  communityId: string,
  channelId: string,
  targetDeviceId: string,
): Promise<CommitEnvelope | null> {
  await ensureDevice();
  const loaded = await loadOwnState(communityId, channelId);
  if (!loaded) {
    return null;
  }
  const impl = await getImpl();
  const leafIndex = leafIndexOfIdentity(loaded.state, targetDeviceId);
  if (leafIndex === null) {
    return null;
  }

  const result = await createCommit(
    { state: loaded.state, cipherSuite: impl },
    {
      wireAsPublicMessage: true,
      extraProposals: [
        { proposalType: "remove", remove: { removed: leafIndex } },
      ],
    },
  );

  const commitB64 = bytesToB64(encodeMlsMessage(result.commit));
  await persistState(
    communityId,
    channelId,
    result.newState,
    loaded.lastAppliedSeq,
  );
  return { ciphertextB64: commitB64, clientMsgId: newMsgId() };
}

/** Device ids (leaf identities) present in this channel's group. */
export async function listGroupDeviceIds(
  communityId: string,
  channelId: string,
): Promise<string[] | null> {
  const loaded = await loadOwnState(communityId, channelId);
  if (!loaded) {
    return null;
  }
  return groupMemberDeviceIds(loaded.state);
}

/**
 * Encrypt one payload object into an application envelope and persist the
 * advanced state. The state is saved BEFORE the caller POSTs, so a crash
 * between encrypt and send loses the message (recoverable by retry) instead
 * of desynchronizing the key schedule.
 */
export async function encryptForChannel(
  communityId: string,
  channelId: string,
  payload: unknown,
): Promise<string> {
  await ensureDevice();
  const loaded = await loadOwnState(communityId, channelId);
  if (!loaded) {
    throw new Error("No encrypted session for this channel yet.");
  }
  const impl = await getImpl();

  const result = await createApplicationMessage(
    loaded.state,
    encoder.encode(JSON.stringify(payload)),
    impl,
  );

  for (const consumed of result.consumed) {
    zeroOutUint8Array(consumed);
  }

  const envelopeB64 = bytesToB64(
    encodeMlsMessage({
      privateMessage: result.privateMessage,
      wireformat: "mls_private_message",
      version: "mls10",
    }),
  );

  await persistState(
    communityId,
    channelId,
    result.newState,
    loaded.lastAppliedSeq,
  );
  return envelopeB64;
}

/**
 * Apply one server row to the local group state.
 * - `commit`: public membership/epoch message — every member processes it.
 * - `application`: private message — decrypts only for members whose keys
 *   match the sending epoch; a removed device's attempt throws (ts-mls
 *   CryptoError), which the caller reports honestly rather than swallowing.
 *
 * Returns the decrypted payload for application rows, or null for commits.
 */
export async function applyEnvelope(
  communityId: string,
  channelId: string,
  row: {
    seq: number;
    kind: "application" | "commit";
    ciphertext: string;
  },
): Promise<{ payload: unknown | null; seq: number }> {
  await ensureDevice();
  const loaded = await loadOwnState(communityId, channelId);
  if (!loaded) {
    throw new Error("No local group state for this channel yet.");
  }
  if (row.seq <= loaded.lastAppliedSeq) {
    return { payload: null, seq: loaded.lastAppliedSeq };
  }
  const impl = await getImpl();
  const decoded = decodedFirst(decodeMlsMessage(b64ToBytes(row.ciphertext), 0));

  if (row.kind === "commit") {
    if (decoded.wireformat !== "mls_public_message") {
      throw new Error("Commit envelope has the wrong wire format.");
    }
    const result = await processPublicMessage(
      loaded.state,
      decoded.publicMessage,
      emptyPskIndex,
      impl,
    );
    await persistState(communityId, channelId, result.newState, row.seq);
    return { payload: null, seq: row.seq };
  }

  if (decoded.wireformat !== "mls_private_message") {
    throw new Error("Application envelope has the wrong wire format.");
  }
  const result = await processPrivateMessage(
    loaded.state,
    decoded.privateMessage,
    emptyPskIndex,
    impl,
  );
  await persistState(communityId, channelId, result.newState, row.seq);
  if (result.kind !== "applicationMessage") {
    // A private message that was really a queued commit/proposal: state
    // advanced, no user payload to surface.
    return { payload: null, seq: row.seq };
  }
  return { payload: JSON.parse(decoder.decode(result.message)), seq: row.seq };
}

/**
 * Fold one addressed welcome into local state (join the group). Idempotent
 * by welcome row id; an already-consumed or undecryptable welcome is a no-op
 * returning false so the sync loop can skip it.
 */
export async function applyWelcome(
  communityId: string,
  channelId: string,
  welcome: {
    id: string;
    ciphertext: string;
    ratchet_tree: string;
    channel_id: string;
  },
): Promise<boolean> {
  if (await isWelcomeConsumed(welcome.id)) {
    return false;
  }
  const { device } = await ensureDevice();
  const impl = await getImpl();
  const decoded = decodedFirst(decodeMlsMessage(b64ToBytes(welcome.ciphertext), 0));
  if (decoded.wireformat !== "mls_welcome") {
    return false;
  }

  const tree = decodeTreeCarrier(b64ToBytes(welcome.ratchet_tree));
  const state = await joinGroup(
    decoded.welcome,
    decodeOwnKeyPackage(device),
    decodeKeyPackagePrivate(device.privatePackageB64),
    emptyPskIndex,
    impl,
    tree,
  );

  await persistState(communityId, channelId, state, 0);
  await markWelcomeConsumed(welcome.id, welcome.channel_id);
  return true;
}

/**
 * The ratchet tree travels with the welcome as public material (public keys
 * and credentials only). ts-mls has no standalone tree codec, so we ship the
 * encoded group state (which contains the tree) as the carrier; the joiner
 * reads `.ratchetTree` out of it. One codec, no invented format.
 */
function encodeTreeCarrier(state: ClientState): Uint8Array {
  return encodeGroupState(state);
}

function decodeTreeCarrier(bytes: Uint8Array): ClientState["ratchetTree"] {
  return decodedFirst(decodeGroupState(bytes, 0)).ratchetTree;
}

async function ensureDeviceOrThrow(): Promise<StoredDevice> {
  const { device } = await ensureDevice();
  return device;
}
