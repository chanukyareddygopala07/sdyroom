/**
 * IndexedDB persistence for community E2EE material. Four stores:
 *
 * - `device`: this browser's MLS identity — device id, the published key
 *   package, and the PRIVATE key package. Private key material never leaves
 *   this record: it is not synced, not sent to any API, and the server has
 *   no column that could hold it.
 * - `groups`: one MLS group state per community channel, as the encoded
 *   `GroupState` plus a watermark of the highest server `seq` applied.
 * - `consumedWelcomes`: welcome ids this device already folded in, so a
 *   refetch does not try to apply the same welcome twice (which would fail
 *   on epoch checks and is wasted work).
 * - `ownMessages`: plaintext copies of the messages THIS device sent,
 *   keyed by the server's `client_msg_id`. MLS senders cannot re-decrypt
 *   their own envelopes — ts-mls consumes (and the caller zeroes) the
 *   generation secret a sent message used — so without this store the
 *   sender's own history would render as "can't be decrypted" after every
 *   reload. Entries are on-device only and are removed when this device
 *   leaves the community.
 *
 * There is deliberately NO export/backup path: recovery on a new device is
 * "register a new device and get Added by a member's client", never key
 * escrow. That trade-off is documented in docs/SECURITY.md.
 */

const DB_NAME = "sdyroom-community-e2ee";
const DB_VERSION = 2;

const STORE_DEVICE = "device";
const STORE_GROUPS = "groups";
const STORE_WELCOMES = "consumedWelcomes";
const STORE_OWN_MESSAGES = "ownMessages";

const DEVICE_KEY = "current";

export type StoredDevice = {
  id: string;
  deviceId: string;
  /** base64 MLS key package (public credential, also published to the API). */
  keyPackageB64: string;
  /** base64-encoded PrivateKeyPackage — private keys, this device only. */
  privatePackageB64: string;
  /** base64 Ed25519 signature public key, shown in device lists. */
  signaturePublicKeyB64: string;
  createdAt: string;
};

export type StoredGroup = {
  /** `${communityId}:${channelId}` */
  id: string;
  communityId: string;
  channelId: string;
  /** base64 encodeGroupState(...) output. */
  stateB64: string;
  /** Highest community_messages.seq applied to this state. */
  lastAppliedSeq: number;
  updatedAt: string;
};

export type StoredConsumedWelcome = {
  /** welcome row id */
  id: string;
  channelId: string;
  consumedAt: string;
};

export type StoredOwnMessage = {
  /** the `client_msg_id` this device sent with the envelope */
  id: string;
  communityId: string;
  channelId: string;
  /** the plaintext payload this device composed (see module header). */
  payload: unknown;
  createdAt: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Test-only: drop the cached DB handle so a test can swap the global
 * `indexedDB` factory and simulate a second browser (second device). Never
 * called by application code.
 */
export function __resetStorageForTests(): void {
  dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this environment."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DEVICE)) {
        db.createObjectStore(STORE_DEVICE);
      }
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS);
      }
      if (!db.objectStoreNames.contains(STORE_WELCOMES)) {
        db.createObjectStore(STORE_WELCOMES);
      }
      if (!db.objectStoreNames.contains(STORE_OWN_MESSAGES)) {
        db.createObjectStore(STORE_OWN_MESSAGES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
  return dbPromise;
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = fn(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB transaction failed"));
  });
}

export async function loadDevice(): Promise<StoredDevice | null> {
  const value = await withStore<StoredDevice | undefined>(
    STORE_DEVICE,
    "readonly",
    (store) => store.get(DEVICE_KEY),
  );
  return value ?? null;
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  await withStore(STORE_DEVICE, "readwrite", (store) =>
    store.put(device, DEVICE_KEY),
  );
}

export async function loadGroup(
  communityId: string,
  channelId: string,
): Promise<StoredGroup | null> {
  const value = await withStore<StoredGroup | undefined>(
    STORE_GROUPS,
    "readonly",
    (store) => store.get(`${communityId}:${channelId}`),
  );
  return value ?? null;
}

export async function saveGroup(group: StoredGroup): Promise<void> {
  await withStore(STORE_GROUPS, "readwrite", (store) =>
    store.put(group, group.id),
  );
}

export async function deleteGroup(communityId: string, channelId: string): Promise<void> {
  await withStore(STORE_GROUPS, "readwrite", (store) =>
    store.delete(`${communityId}:${channelId}`),
  );
}

export async function listGroupsForCommunity(
  communityId: string,
): Promise<StoredGroup[]> {
  const all = await withStore<StoredGroup[]>(STORE_GROUPS, "readonly", (store) =>
    store.getAll(),
  );
  return all.filter((group) => group.communityId === communityId);
}

export async function isWelcomeConsumed(welcomeId: string): Promise<boolean> {
  const value = await withStore<StoredConsumedWelcome | undefined>(
    STORE_WELCOMES,
    "readonly",
    (store) => store.get(welcomeId),
  );
  return value !== undefined;
}

export async function markWelcomeConsumed(
  welcomeId: string,
  channelId: string,
): Promise<void> {
  await withStore(STORE_WELCOMES, "readwrite", (store) =>
    store.put(
      { id: welcomeId, channelId, consumedAt: new Date().toISOString() },
      welcomeId,
    ),
  );
}

/** Record the plaintext of a message this device is about to send. */
export async function rememberOwnMessage(entry: StoredOwnMessage): Promise<void> {
  await withStore(STORE_OWN_MESSAGES, "readwrite", (store) =>
    store.put(entry, entry.id),
  );
}

/** Plaintext of a message this device sent, or null (foreign/never sent). */
export async function recallOwnMessage(clientMsgId: string): Promise<unknown | null> {
  const value = await withStore<StoredOwnMessage | undefined>(
    STORE_OWN_MESSAGES,
    "readonly",
    (store) => store.get(clientMsgId),
  );
  return value?.payload ?? null;
}

/** Drop one entry — used when a send failed and no server row exists. */
export async function forgetOwnMessage(clientMsgId: string): Promise<void> {
  await withStore(STORE_OWN_MESSAGES, "readwrite", (store) =>
    store.delete(clientMsgId),
  );
}

async function forgetOwnMessagesWhere(
  predicate: (entry: StoredOwnMessage) => boolean,
): Promise<void> {
  const all = await withStore<StoredOwnMessage[]>(
    STORE_OWN_MESSAGES,
    "readonly",
    (store) => store.getAll(),
  );
  const doomed = all.filter(predicate);
  if (doomed.length === 0) {
    return;
  }
  await withStore(STORE_OWN_MESSAGES, "readwrite", (store) => {
    for (const entry of doomed) {
      store.delete(entry.id);
    }
    return store.get(doomed[0]!.id);
  });
}

/** Leave flow: this device forgets the channel's sent-message plaintext. */
export async function forgetOwnMessagesForChannel(channelId: string): Promise<void> {
  await forgetOwnMessagesWhere((entry) => entry.channelId === channelId);
}

/** Full local teardown for a community (leave/delete): all sent plaintext. */
export async function forgetOwnMessagesForCommunity(
  communityId: string,
): Promise<void> {
  await forgetOwnMessagesWhere((entry) => entry.communityId === communityId);
}
