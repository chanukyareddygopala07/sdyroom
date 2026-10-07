"use client";

import { ChatPanel } from "@/components/chat-panel";
import { toChatMessageView } from "@/lib/chat/queries";
import {
  presenceChannelTopic,
  PRESENCE_HEARTBEAT_MS,
  toParticipants,
  type PresenceState,
} from "@/lib/chat/presence";
import type {
  ChatConnectionState,
  ChatMessageView,
  ChatParticipant,
} from "@/lib/chat/types";
import { useStudying } from "@/lib/focus/studying-store";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type SupabaseBrowserClient = ReturnType<typeof createClient>;
type RealtimeChannel = ReturnType<SupabaseBrowserClient["channel"]>;

/** The viewer's identity, read once per mount and shared by both channels. */
type Viewer = { id: string; alias: string };

/**
 * Re-sends a track. The promise is swallowed on purpose: a failed track is
 * retried by the next heartbeat or by the studying change that follows, and
 * neither the badge nor the roster may break over one rejected push.
 */
function trackPresence(
  channel: RealtimeChannel,
  payload: { alias: string; studying: boolean },
): void {
  void channel.track(payload).catch(() => undefined);
}

/**
 * The browser's own verdict on the network. The `offline`/`online` events it
 * drives land the moment connectivity changes, while the socket's error can
 * lag by tens of seconds — so the connection badge follows them before any
 * stale callback can speak.
 */
function browserIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Owns the chat data layer and renders the props-driven {@link ChatPanel}.
 *
 * Responsibilities, in the order they matter to the badge the user reads:
 *
 * - **History** arrives server-rendered with the workspace page — the same
 *   pattern as the timer's snapshots and the goals list — so there is no
 *   mount-time fetch to fail or flash a spinner.
 * - **Live updates** come only from a Realtime subscription on the room's
 *   messages — there is no chat poll to mask a dead socket — so the badge's
 *   `Live` requires the join ack (`wait: true`), and drops to `Reconnecting…`
 *   on channel errors or when the browser reports offline. The socket itself
 *   is re-dialed and re-subscribed by the Supabase client; this component
 *   never fabricates recovery it has not observed.
 * - **Sends** are optimistic: the message appears as `pending` under the
 *   viewer's own alias, is replaced by the server row on 201, and becomes
 *   `failed` with the panel's retry control otherwise. An event confirming
 *   the same message first is deduplicated by id, so whichever of the POST
 *   response and the Realtime event lands second removes the optimistic row.
 * - **Presence** rides a second, private channel (`room-presence-{roomId}`,
 *   authorized per-topic by `0006_realtime_private_channels.sql`) so the two
 *   surfaces fail apart: a chat error must not blank the roster, and a
 *   refused presence join must not take the chat badge with it. The roster
 *   stays `undefined` — and hidden — until the first presence sync arrives,
 *   and on a channel error it keeps the last list it actually observed
 *   rather than inventing an empty room.
 */
export function RoomChat({
  roomId,
  initialMessages,
}: {
  roomId: string;
  initialMessages: ChatMessageView[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessageView[]>(initialMessages);
  const [connection, setConnection] =
    useState<ChatConnectionState>("connecting");

  /** The join has been acknowledged; only then may the badge say `Live`. */
  const subscribedRef = useRef(false);
  const userIdRef = useRef("");
  const aliasRef = useRef("");
  const messagesRef = useRef<ChatMessageView[]>([]);
  const localSeqRef = useRef(0);

  /**
   * The last roster *observed for this room*, or nothing yet — `undefined`
   * keeps the section hidden rather than flashing an empty room. Keying the
   * state by room means a room change renders "not observed" with no effect
   * having to clear anything: the previous room's roster simply no longer
   * matches the topic on screen.
   */
  const [roster, setRoster] = useState<
    { roomId: string; participants: ChatParticipant[] } | undefined
  >(undefined);
  const participants =
    roster !== undefined && roster.roomId === roomId
      ? roster.participants
      : undefined;
  const studying = useStudying();
  const studyingRef = useRef(studying);
  const presenceChannelRef = useRef<RealtimeChannel | null>(null);

  /**
   * One browser client for both channels: same socket, same token, and the
   * effects below share one auth read instead of asking twice per mount.
   */
  const [supabase] = useState<SupabaseBrowserClient>(createClient);

  const viewerPromiseRef = useRef<Promise<Viewer> | null>(null);

  /**
   * The single auth read for this mount: identity, alias, and the session
   * token on the client before any join is built — the repo's "auth before
   * join" rule, applied once for both channels so neither can race ahead of
   * registration. Cached, so the messages and presence effects observe the
   * same viewer even when they run concurrently; a failure is cached too,
   * because a viewer who is signed out stays signed out for this mount.
   */
  const loadViewer = useCallback((): Promise<Viewer> => {
    viewerPromiseRef.current ??= (async (): Promise<Viewer> => {
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) {
        throw new Error("no session");
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("alias")
        .eq("id", user.id)
        .maybeSingle();
      const alias =
        typeof profile?.alias === "string" ? profile.alias.trim() : "";

      await supabase.realtime.setAuth();

      userIdRef.current = user.id;
      aliasRef.current = alias;
      return { id: user.id, alias };
    })();
    return viewerPromiseRef.current;
  }, [supabase]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const deliver = useCallback(
    async (localId: string, body: string) => {
      try {
        const response = await fetch(`/api/rooms/${roomId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });

        if (response.status === 401) {
          router.push("/auth/login");
          return;
        }

        const payload = (await response.json().catch(() => null)) as
          | { message?: ChatMessageView }
          | null;
        const message = payload?.message;
        if (!response.ok || !message) {
          throw new Error("send rejected");
        }

        setMessages((current) =>
          current.some((item) => item.id === message.id)
            ? // The Realtime event already delivered this message; the
              // optimistic row has served its purpose.
              current.filter((item) => item.id !== localId)
            : current.map((item) => (item.id === localId ? message : item)),
        );
      } catch {
        setMessages((current) =>
          current.map((item) =>
            item.id === localId ? { ...item, status: "failed" } : item,
          ),
        );
      }
    },
    [roomId, router],
  );

  const handleSend = useCallback(
    (body: string) => {
      localSeqRef.current += 1;
      const localId = `local-${localSeqRef.current}`;
      setMessages((current) => [
        ...current,
        {
          id: localId,
          alias: aliasRef.current,
          body,
          created_at: new Date().toISOString(),
          status: "pending",
          is_own: true,
        },
      ]);
      void deliver(localId, body);
    },
    [deliver],
  );

  const handleRetrySend = useCallback(
    (id: string) => {
      const target = messagesRef.current.find((item) => item.id === id);
      if (!target || target.status !== "failed") {
        return;
      }
      setMessages((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: "pending" } : item,
        ),
      );
      void deliver(id, target.body);
    },
    [deliver],
  );

  // The browser knows first: `offline`/`online` fire the moment connectivity
  // changes, while the socket surfaces its own error only after rejoin
  // timeouts. The badge follows those events directly; the Supabase client
  // re-dials the socket and re-subscribes the channel on its own.
  useEffect(() => {
    const onOffline = () => setConnection("reconnecting");
    const onOnline = () => setConnection("connecting");

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Realtime: history covers the past; every message from now on arrives as
  // an event, so delivery — not a poll — is what the badge describes.
  useEffect(() => {
    let disposed = false;
    let channel: RealtimeChannel | null = null;

    const connect = async () => {
      try {
        // The session token must be on the client before the join goes out,
        // or the change filter registers as `anon` and is rejected; `wait:
        // true` then holds the join reply until registration is confirmed,
        // so `SUBSCRIBED` — the badge's `Live` — means frames will be
        // delivered, not merely that a socket exists. `loadViewer` performs
        // that registration once, shared with the presence channel.
        await loadViewer();
        if (disposed) return;

        channel = supabase
          .channel(`room-messages-${roomId}`, {
            config: { postgres_changes_options: { wait: true } },
          })
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "room_messages",
              filter: `room_id=eq.${roomId}`,
            },
            (payload) => {
              if (disposed) return;
              try {
                const view = toChatMessageView(
                  payload.new,
                  userIdRef.current,
                );
                setMessages((current) =>
                  current.some((item) => item.id === view.id)
                    ? current
                    : [...current, view],
                );
              } catch {
                // A malformed row is dropped rather than breaking the stream.
              }
            },
          )
          .subscribe((status) => {
            if (disposed) return;
            if (status === "SUBSCRIBED") {
              // An ack that raced the connection dropping must not paint
              // `Live` over the offline indication.
              if (browserIsOffline()) {
                setConnection("reconnecting");
                return;
              }
              subscribedRef.current = true;
              setConnection("live");
              return;
            }
            subscribedRef.current = false;
            setConnection(
              status === "CHANNEL_ERROR" || status === "TIMED_OUT"
                ? "reconnecting"
                : "connecting",
            );
          });
      } catch {
        // Without auth the join would be rejected server-side; say so instead
        // of pretending to be live.
        if (!disposed) setConnection("reconnecting");
      }
    };

    void connect();

    return () => {
      disposed = true;
      subscribedRef.current = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [roomId, loadViewer, supabase]);

  // Presence: the roster rides its own private channel so the two surfaces
  // fail apart — a chat error never blanks who is here, and a refused join
  // never takes the chat badge down. `setAuth` happened inside `loadViewer`,
  // before this join is built, and the topic is authorized per-room by the
  // realtime.messages policy from migration 0006.
  useEffect(() => {
    let disposed = false;
    let channel: RealtimeChannel | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    // One sync handler for the channel's whole life: every join, leave and
    // re-track arrives as `sync`, so the roster is only ever rebuilt from a
    // state the server actually sent, tagged with the room it describes.
    const sync = () => {
      if (disposed || !channel) return;
      const state: PresenceState = channel.presenceState();
      setRoster({
        roomId,
        participants: toParticipants(state, aliasRef.current),
      });
    };

    const connect = async () => {
      try {
        const viewer = await loadViewer();
        if (disposed) return;
        // Presence without an alias would put an empty badge where the
        // viewer's own should be (an alias comes from onboarding); the
        // honest rendering is to show no roster at all.
        if (!viewer.alias) return;

        // Bound to a const first so the status callback never sees a null
        // channel: the assignment below runs before `subscribe`, even if a
        // transport answers the join synchronously.
        const open = supabase
          .channel(presenceChannelTopic(roomId), {
            config: { private: true, presence: { enabled: true } },
          })
          .on("presence", { event: "sync" }, sync);
        channel = open;
        presenceChannelRef.current = open;

        open.subscribe((status) => {
          if (disposed) return;
          if (status === "SUBSCRIBED") {
            trackPresence(open, {
              alias: viewer.alias,
              studying: studyingRef.current,
            });
            // A half-open socket the server never saw is cleaned up by
            // this re-track — and it is the retry bound: nothing here
            // re-tracks faster than the heartbeat unless the state below
            // actually changes.
            heartbeat = setInterval(() => {
              if (disposed) return;
              trackPresence(open, {
                alias: viewer.alias,
                studying: studyingRef.current,
              });
            }, PRESENCE_HEARTBEAT_MS);
          }
          // CHANNEL_ERROR / TIMED_OUT: keep the last observed roster. The
          // connection badge already carries the socket's truth, and a
          // roster must never be replaced by a guess.
        });
      } catch {
        // Signed out or un-onboarded: no channel, `participants` stays
        // undefined, and the panel keeps its section hidden.
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      const open = channel;
      presenceChannelRef.current = null;
      if (open) {
        // Leave the roster explicitly before closing: a socket the server
        // notices cannot linger as a ghost.
        void open.untrack().catch(() => undefined);
        void supabase.removeChannel(open);
      }
    };
  }, [roomId, loadViewer, supabase]);

  // A session starting or ending changes what this client says about itself,
  // so it re-tracks at once instead of waiting out the 60-second heartbeat.
  useEffect(() => {
    studyingRef.current = studying;
    const channel = presenceChannelRef.current;
    if (channel && aliasRef.current) {
      trackPresence(channel, { alias: aliasRef.current, studying });
    }
  }, [studying]);

  return (
    <ChatPanel
      messages={messages}
      connection={connection}
      participants={participants}
      onSend={handleSend}
      onRetrySend={handleRetrySend}
    />
  );
}
