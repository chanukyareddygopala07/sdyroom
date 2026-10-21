"use client";

/**
 * Community channel workspace: the client-side pipeline that turns opaque
 * MLS envelopes into readable messages and back.
 *
 * On mount it: registers this browser's device, runs the membership sync
 * (Adds/Removes per channel group), replays history through the MLS layer
 * (idempotent via the seq watermark), and subscribes to new ciphertext over
 * realtime. Sending encrypts locally first, then POSTs the envelope.
 *
 * Failure honesty: a row this device cannot decrypt renders as an explicit
 * "cannot decrypt" placeholder — never as an empty bubble and never as a
 * silent drop. Causes are a missing/wrong welcome (device not yet Added) or
 * a membership change this device has not applied yet; both resolve on the
 * next successful sync + refetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  listMessagesClient,
  sendMessageClient,
  type CommunityApiError,
} from "@/lib/communities/api";
import {
  canBootstrapGroup,
  ensureDeviceRegistered,
  syncCommunity,
  type SyncContext,
} from "@/lib/communities/sync";
import { applyEnvelope, encryptForChannel } from "@/lib/crypto/mls";
import { recallOwnMessage, rememberOwnMessage } from "@/lib/crypto/storage";
import {
  parseCommunityPayload,
  type CommunityPayload,
} from "@/lib/communities/payload";
import type { CommunityMessageRow } from "@/lib/communities/types";

export type WorkspaceMessage = {
  id: string;
  seq: number;
  senderId: string;
  senderDeviceId: string;
  createdAt: string;
  /** Decrypted payload, or null when this device cannot decrypt the row. */
  payload: CommunityPayload | null;
  /** True when the envelope exists but decryption failed. */
  undecryptable: boolean;
  isOwn: boolean;
};

export type WorkspaceState = "loading" | "syncing" | "ready" | "error";

export type UseCommunityWorkspaceOptions = {
  communityId: string;
  channelId: string;
  userId: string;
  isOwner: boolean;
  /** Active members ordered by joined_at asc (bootstrap determinism). */
  memberOrder: Array<{ userId: string; joinedAt: string }>;
  /** Pauses the pipeline when false (e.g. membership not active yet). */
  enabled: boolean;
};

const HISTORY_LIMIT = 50;

export function useCommunityWorkspace(options: UseCommunityWorkspaceOptions) {
  const {
    communityId,
    channelId,
    userId,
    isOwner,
    memberOrder,
    enabled,
  } = options;

  const [state, setState] = useState<WorkspaceState>("loading");
  const [messages, setMessages] = useState<WorkspaceMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const historyLoadedRef = useRef(false);
  const mountedRef = useRef(true);

  const syncContext: SyncContext = useMemo(
    () => ({ communityId, userId, isOwner, memberOrder }),
    [communityId, userId, isOwner, memberOrder],
  );

  const applyRow = useCallback(
    async (row: CommunityMessageRow): Promise<WorkspaceMessage> => {
      const base: Omit<WorkspaceMessage, "payload" | "undecryptable"> = {
        id: row.id,
        seq: row.seq,
        senderId: row.sender_id,
        senderDeviceId: row.sender_device_id,
        createdAt: row.created_at,
        isOwn: row.sender_id === userId,
      };
      // Messages this device sent are rendered from the local plaintext
      // cache: MLS senders cannot re-decrypt their own envelopes (ts-mls
      // consumes the generation secret a sent message used), so the
      // decrypt path below would always fail for them. Foreign rows miss
      // the cache by construction — the key is the sender's clientMsgId.
      const cached = await recallOwnMessage(row.client_msg_id).catch(
        () => null,
      );
      if (cached !== null) {
        const payload = parseCommunityPayload(cached);
        if (payload !== null) {
          return { ...base, payload, undecryptable: false };
        }
      }
      if (row.kind === "commit") {
        try {
          await applyEnvelope(communityId, channelId, {
            seq: row.seq,
            kind: "commit",
            ciphertext: row.ciphertext,
          });
        } catch {
          // A commit this device cannot verify (stale epoch) leaves state
          // unchanged; subsequent rows may also fail and show as such.
        }
        return { ...base, payload: null, undecryptable: false };
      }
      try {
        const result = await applyEnvelope(communityId, channelId, {
          seq: row.seq,
          kind: "application",
          ciphertext: row.ciphertext,
        });
        return {
          ...base,
          payload: parseCommunityPayload(result.payload),
          undecryptable: false,
        };
      } catch {
        return { ...base, payload: null, undecryptable: true };
      }
    },
    [communityId, channelId, userId],
  );

  const loadHistory = useCallback(
    async (before?: number): Promise<void> => {
      const page = await listMessagesClient(communityId, channelId, {
        ...(before !== undefined ? { before } : {}),
        limit: HISTORY_LIMIT,
      });

      // Apply oldest-first so epoch order is preserved.
      const ordered = [...page.messages].sort((a, b) => a.seq - b.seq);
      const applied: WorkspaceMessage[] = [];
      for (const row of ordered) {
        applied.push(await applyRow(row));
      }

      if (!mountedRef.current) {
        return;
      }
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id));
        const fresh = applied.filter((message) => !seen.has(message.id));
        return [...fresh, ...current].sort((a, b) => a.seq - b.seq);
      });
      setHasMore(page.has_more);
    },
    [communityId, channelId, applyRow],
  );

  const runSyncAndHistory = useCallback(async (): Promise<void> => {
    setState((current) => (current === "loading" ? "loading" : "syncing"));
    try {
      const registered = await ensureDeviceRegistered();
      setDeviceId(registered.deviceId);

      await syncCommunity(syncContext, [channelId]);

      if (!historyLoadedRef.current) {
        historyLoadedRef.current = true;
        await loadHistory();
      }
      if (mountedRef.current) {
        setState("ready");
        setError(null);
      }
    } catch (caught) {
      if (!mountedRef.current) {
        return;
      }
      const message =
        caught instanceof Error
          ? "Encryption setup failed for this channel. Check your connection and reload."
          : "Encryption setup failed for this channel.";
      setError(message);
      setState("error");
    }
  }, [syncContext, channelId, loadHistory]);

  // Realtime: new ciphertext rows arrive as INSERTs; decrypt on arrival.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const supabase = createClient();
    const channel = supabase
      .channel(`community-messages-${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "community_messages",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const row = payload.new as CommunityMessageRow;
          void (async () => {
            const applied = await applyRow(row);
            if (!mountedRef.current) {
              return;
            }
            setMessages((current) =>
              current.some((message) => message.id === applied.id)
                ? current
                : [...current, applied].sort((a, b) => a.seq - b.seq),
            );
          })();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [channelId, enabled, applyRow]);

  // Mount: sync + history. Remount on channel change resets watermarks.
  // State writes are deferred a microtask so the effect body itself performs
  // none synchronously (react-hooks/set-state-in-effect), with cancellation
  // covering a fast channel switch.
  useEffect(() => {
    mountedRef.current = true;
    historyLoadedRef.current = false;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || !mountedRef.current) {
        return;
      }
      setMessages([]);
      setHasMore(false);
      if (enabled) {
        setState("loading");
        void runSyncAndHistory();
      }
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSyncAndHistory is a stable callback chain; re-running it on identity churn would refetch in a loop.
  }, [communityId, channelId, enabled]);

  const send = useCallback(
    async (payload: CommunityPayload): Promise<void> => {
      if (!deviceId) {
        throw new Error("Device is not registered yet.");
      }
      setSending(true);
      try {
        const ciphertext = await encryptForChannel(
          communityId,
          channelId,
          payload,
        );
        const clientMsgId = crypto.randomUUID();
        // Cache BEFORE the POST: the realtime echo can land the moment the
        // server row exists, and this device must be able to read its own
        // message then and after any reload (see applyRow). The entry is
        // kept even if the POST errors — the row may exist when only the
        // response was lost, and an entry with no row is a harmless orphan
        // that leave-flow cleanup removes. A cache-write failure only costs
        // the honest "can't decrypt" placeholder for this device's own row,
        // never the send itself.
        await rememberOwnMessage({
          id: clientMsgId,
          communityId,
          channelId,
          payload,
          createdAt: new Date().toISOString(),
        }).catch(() => undefined);
        await sendMessageClient(communityId, channelId, {
          kind: "application",
          ciphertext,
          clientMsgId,
          senderDeviceId: deviceId,
        });
        // The realtime INSERT delivers the row; nothing to append locally.
      } finally {
        setSending(false);
      }
    },
    [communityId, channelId, deviceId],
  );

  const loadOlder = useCallback(async (): Promise<void> => {
    const oldest = messages[0];
    if (!oldest || !hasMore) {
      return;
    }
    await loadHistory(oldest.seq);
  }, [messages, hasMore, loadHistory]);

  const refresh = useCallback(async (): Promise<void> => {
    await runSyncAndHistory().catch(() => undefined);
    await loadHistory().catch(() => undefined);
  }, [runSyncAndHistory, loadHistory]);

  const canSend = state === "ready" && !sending;

  return {
    state,
    messages,
    hasMore,
    error,
    sending,
    canSend,
    send,
    loadOlder,
    refresh,
    deviceId,
    /** Mirrors the bootstrap rule so the UI can explain a waiting channel. */
    willBootstrap: canBootstrapGroup(syncContext),
  };
}

export type { CommunityApiError };
