import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetStorageForTests,
  forgetOwnMessage,
  forgetOwnMessagesForChannel,
  forgetOwnMessagesForCommunity,
  recallOwnMessage,
  rememberOwnMessage,
} from "@/lib/crypto/storage";

/**
 * The sent-message plaintext cache (`ownMessages`): the sender's only way
 * to re-read its own history, because ts-mls senders cannot re-decrypt
 * (see mls-own-message-contract.test.ts).
 */

const COMMUNITY_A = "11111111-1111-1111-1111-111111111111";
const COMMUNITY_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHANNEL_1 = "22222222-2222-2222-2222-222222222222";
const CHANNEL_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetStorageForTests();
});

describe("own-message plaintext cache", () => {
  it("round-trips a sent payload by clientMsgId", async () => {
    const payload = { v: 1, t: "text", body: "see you at noon" };
    await rememberOwnMessage({
      id: "client-1",
      communityId: COMMUNITY_A,
      channelId: CHANNEL_1,
      payload,
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    await expect(recallOwnMessage("client-1")).resolves.toEqual(payload);
  });

  it("returns null for ids this device never sent", async () => {
    await expect(recallOwnMessage("someone-elses-id")).resolves.toBeNull();
  });

  it("forgets a single entry", async () => {
    await rememberOwnMessage({
      id: "client-2",
      communityId: COMMUNITY_A,
      channelId: CHANNEL_1,
      payload: { v: 1, t: "text", body: "x" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    await forgetOwnMessage("client-2");
    await expect(recallOwnMessage("client-2")).resolves.toBeNull();
  });

  it("purges one channel without touching another", async () => {
    await rememberOwnMessage({
      id: "c1-msg",
      communityId: COMMUNITY_A,
      channelId: CHANNEL_1,
      payload: { v: 1, t: "text", body: "channel one" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    await rememberOwnMessage({
      id: "c2-msg",
      communityId: COMMUNITY_A,
      channelId: CHANNEL_2,
      payload: { v: 1, t: "text", body: "channel two" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    await forgetOwnMessagesForChannel(CHANNEL_1);
    await expect(recallOwnMessage("c1-msg")).resolves.toBeNull();
    await expect(recallOwnMessage("c2-msg")).resolves.toBeDefined();
  });

  it("purges a whole community without touching another", async () => {
    await rememberOwnMessage({
      id: "a-msg",
      communityId: COMMUNITY_A,
      channelId: CHANNEL_1,
      payload: { v: 1, t: "text", body: "community a" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    await rememberOwnMessage({
      id: "b-msg",
      communityId: COMMUNITY_B,
      channelId: CHANNEL_2,
      payload: { v: 1, t: "text", body: "community b" },
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    await forgetOwnMessagesForCommunity(COMMUNITY_A);
    await expect(recallOwnMessage("a-msg")).resolves.toBeNull();
    await expect(recallOwnMessage("b-msg")).resolves.toBeDefined();
  });
});
