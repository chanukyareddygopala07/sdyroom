"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatConnectionState,
  type ChatMessageView,
  type ChatParticipant,
} from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { useId, useEffect, useRef, useState } from "react";

/** How close to the bottom (px) still counts as "reading the newest messages". */
const STICK_TO_BOTTOM_PX = 80;

const connectionCopy: Record<ChatConnectionState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  unavailable: "Chat unavailable",
};

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : timeFormat.format(date);
}

/**
 * The room chat panel: message history, composer and connection state.
 *
 * Deliberately props-driven — it renders `messages`, `participants` and the
 * `connection` state it is given and reports intent through `onSend` /
 * `onRetrySend` / `onRetryLoad`. The data layer (REST history, Realtime
 * updates, presence) arrives with the backend contract in a follow-up, so
 * this component never fetches and can never pretend a send succeeded: a
 * failed message stays on screen with its retry control until the owner of
 * the state says otherwise.
 *
 * Scroll rule: new messages only move the viewport when the reader is
 * already near the bottom; otherwise their position is kept and a "New
 * messages" control appears instead of yanking them down.
 */
export function ChatPanel({
  messages,
  connection,
  loading = false,
  loadError = null,
  onRetryLoad,
  onSend,
  onRetrySend,
  participants,
}: {
  messages: ChatMessageView[];
  connection: ChatConnectionState;
  /** The initial history read is still in flight. */
  loading?: boolean;
  /** History read failed; shown with a retry when `onRetryLoad` is given. */
  loadError?: string | null;
  onRetryLoad?: () => void;
  /** Hand off a trimmed message body; the owner persists it. */
  onSend: (body: string) => void;
  /** Re-send a failed message; owner flips it back to `pending`. */
  onRetrySend?: (id: string) => void;
  /** Presence only renders when the approved contract provides it. */
  participants?: ChatParticipant[];
}) {
  const [draft, setDraft] = useState("");
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const previousCountRef = useRef(messages.length);
  const hintId = useId();

  // Auto-scroll only while the reader was already at the newest messages;
  // otherwise keep their place and surface the jump control instead.
  useEffect(() => {
    const element = listRef.current;
    const grew = messages.length > previousCountRef.current;
    previousCountRef.current = messages.length;
    if (!element) return;

    if (stickRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (grew) {
      setShowJump(true);
    }
  }, [messages]);

  const handleScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      STICK_TO_BOTTOM_PX;
    stickRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  };

  const jumpToNewest = () => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  };

  const canSend =
    draft.trim().length > 0 &&
    draft.length <= CHAT_MESSAGE_MAX_LENGTH &&
    connection !== "unavailable";

  const sendDraft = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendDraft();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    sendDraft();
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border p-5"
      aria-label="Chat"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Chat</h2>
        <p role="status" className="text-xs text-muted-foreground">
          {connectionCopy[connection]}
        </p>
      </div>

      {participants !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Participants</span>
          {participants.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              Nobody here but you
            </span>
          ) : (
            <ul
              aria-label="Participants"
              className="flex flex-wrap items-center gap-1.5"
            >
              {participants.map((participant) => (
                <li key={participant.alias}>
                  <Badge variant="outline">{participant.alias}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading messages…
        </p>
      ) : loadError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-red-500">
            {loadError}
          </p>
          {onRetryLoad && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetryLoad}
            >
              Retry loading messages
            </Button>
          )}
        </div>
      ) : messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No messages yet. Say hello to your study partners.
        </p>
      ) : (
        <div className="relative">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="max-h-[60vh] min-h-40 overflow-y-auto overscroll-contain pr-1"
          >
            <ul
              aria-label="Chat messages"
              className="flex flex-col gap-2"
            >
              {messages.map((message) => {
                const time = formatTime(message.created_at);
                return (
                  <li
                    key={message.id}
                    data-own={message.is_own ? "true" : undefined}
                    className={cn(
                      "flex max-w-[85%] flex-col gap-1 rounded-lg border p-3",
                      message.is_own ? "self-end bg-accent/60" : "self-start",
                    )}
                  >
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium">
                        {message.alias}
                      </span>
                      {time && (
                        <time
                          dateTime={message.created_at}
                          className="text-xs text-muted-foreground"
                        >
                          {time}
                        </time>
                      )}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-sm">
                      {message.body}
                    </span>
                    {message.status === "pending" && (
                      <span className="text-xs text-muted-foreground">
                        Sending…
                      </span>
                    )}
                    {message.status === "failed" && (
                      <span className="flex flex-wrap items-center gap-2">
                        <span role="alert" className="text-xs text-red-500">
                          Not sent.
                        </span>
                        {onRetrySend && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onRetrySend(message.id)}
                          >
                            Try again
                          </Button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {showJump && (
            <button
              type="button"
              onClick={jumpToNewest}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-background px-3 py-1 text-xs shadow-xs"
            >
              New messages
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t pt-4">
        <div className="flex flex-wrap items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Message"
            aria-describedby={hintId}
            placeholder="Message the room…"
            maxLength={CHAT_MESSAGE_MAX_LENGTH}
            className="min-h-16 min-w-44 flex-1 resize-y"
          />
          <Button type="submit" size="sm" disabled={!canSend}>
            Send
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{`${draft.length} / ${CHAT_MESSAGE_MAX_LENGTH}`}</span>
          <span id={hintId}>
            Enter to send, Shift + Enter for a new line
          </span>
        </div>
      </form>
    </section>
  );
}
