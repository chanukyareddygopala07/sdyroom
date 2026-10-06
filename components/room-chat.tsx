"use client";

import { ChatPanel } from "@/components/chat-panel";
import { toChatMessageView } from "@/lib/chat/queries";
import type { ChatConnectionState, ChatMessageView } from "@/lib/chat/types";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

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
 *
 * Participant presence is deliberately not wired: no `participants` prop is
 * passed, so the panel keeps that section hidden until its contract exists.
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
    const supabase = createClient();
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const connect = async () => {
      try {
        // The session token must be on the client before the join goes out,
        // or the change filter registers as `anon` and is rejected; `wait:
        // true` then holds the join reply until registration is confirmed,
        // so `SUBSCRIBED` — the badge's `Live` — means frames will be
        // delivered, not merely that a socket exists.
        const { data: userData } = await supabase.auth.getUser();
        const user = userData.user;
        if (disposed) return;
        if (!user) throw new Error("no session");
        userIdRef.current = user.id;

        const { data: profile } = await supabase
          .from("profiles")
          .select("alias")
          .eq("id", user.id)
          .maybeSingle();
        if (disposed) return;
        if (profile && typeof profile.alias === "string") {
          aliasRef.current = profile.alias;
        }

        await supabase.realtime.setAuth();
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
  }, [roomId]);

  return (
    <ChatPanel
      messages={messages}
      connection={connection}
      onSend={handleSend}
      onRetrySend={handleRetrySend}
    />
  );
}
