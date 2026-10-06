import type { Page } from "@playwright/test";
import type { WebSocketRoute } from "playwright-core";

export type PostgresEvent = {
  /** The raw frame as the server sent it — replayable with `inject`. */
  raw: string;
  type: "INSERT" | "UPDATE" | "DELETE" | string;
  record: Record<string, unknown>;
};

function parsePostgresFrame(raw: string): PostgresEvent | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  let payload: unknown;
  if (Array.isArray(message)) {
    // Phoenix wire format: [join_ref, ref, topic, event, payload].
    if (message[3] !== "postgres_changes") return null;
    payload = message[4];
  } else if (message && typeof message === "object") {
    if ((message as { event?: unknown }).event !== "postgres_changes") return null;
    payload = (message as { payload?: unknown }).payload;
  } else {
    return null;
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = (body.data ?? body) as Record<string, unknown>;
  const type = typeof data.type === "string" ? data.type : "UNKNOWN";
  const record =
    data.record && typeof data.record === "object"
      ? (data.record as Record<string, unknown>)
      : {};
  return { raw, type, record };
}

export type RealtimeCapture = {
  /** Every server → page frame seen so far (heartbeats and joins included). */
  frames: string[];
  /** Parsed `postgres_changes` deliveries in arrival order. */
  events(): PostgresEvent[];
  /** The nth (default: first) INSERT frame for a room, for replay tests. */
  insertFrame(roomId: string, occurrence?: number): PostgresEvent;
  /** Delivers a raw frame into the page as if the server had sent it. */
  inject(raw: string): void;
};

/**
 * Intercepts the page's Supabase realtime socket with
 * `page.routeWebSocket`, relays it to the real local server and records every
 * server → page frame. Recording the raw frames lets a test replay a stale or
 * duplicate `postgres_changes` message into the client and assert the app
 * recovers from it instead of corrupting its view.
 *
 * Must be registered before the page opens the socket (i.e. before the first
 * navigation that creates the Supabase client).
 */
export async function captureRealtime(page: Page): Promise<RealtimeCapture> {
  const frames: string[] = [];
  let route: WebSocketRoute | null = null;

  const parseEvents = (): PostgresEvent[] =>
    frames
      .map(parsePostgresFrame)
      .filter((event): event is PostgresEvent => event !== null);

  await page.routeWebSocket(
    (url) => url.pathname === "/realtime/v1/websocket",
    (socket) => {
      route = socket;
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const text = typeof message === "string" ? message : message.toString();
        frames.push(text);
        // onMessage stops Playwright's automatic forwarding, so re-deliver
        // every frame to the page ourselves — observation without mutation.
        socket.send(text);
      });
    },
  );

  return {
    frames,
    events: parseEvents,
    insertFrame(roomId, occurrence = 0) {
      const matches = parseEvents().filter(
        (event) => event.type === "INSERT" && event.record.room_id === roomId,
      );
      const found = matches[occurrence];
      if (!found) {
        throw new Error(
          `No INSERT frame #${occurrence} for room ${roomId} in ${frames.length} frames.`,
        );
      }
      return found;
    },
    inject(raw) {
      if (!route) {
        throw new Error("The realtime socket has not been opened yet.");
      }
      route.send(raw);
    },
  };
}

/** Counts the workspace reads a page performs (poll and event driven). */
export function countWorkspaceRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (/\/api\/rooms\/[0-9a-f-]{36}\/workspace$/.test(request.url())) {
      count += 1;
    }
  });
  return () => count;
}
