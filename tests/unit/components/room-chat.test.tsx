// @vitest-environment jsdom
import { RoomChat } from "@/components/room-chat";
import { presenceChannelTopic } from "@/lib/chat/presence";
import type { ChatMessageView } from "@/lib/chat/types";
import { publishStudying } from "@/lib/focus/studying-store";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  /**
   * One mock per channel topic: the component now opens two channels (chat
   * and presence) and each has its own status callback, handlers and track
   * calls. A single shared object would let a presence status overwrite the
   * chat's — the exact cross-talk the two-channel design exists to avoid.
   */
  type ChannelMock = {
    topic: string;
    config: unknown;
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    untrack: ReturnType<typeof vi.fn>;
    presenceState: ReturnType<typeof vi.fn>;
    emitStatus: (status: string) => void;
    emitInsert: (record: unknown) => void;
    emitPresenceSync: (state: Record<string, unknown[]>) => void;
  };

  const channels = new Map<string, ChannelMock>();

  function createChannel(topic: string, config?: unknown): ChannelMock {
    let statusCallback: ((status: string) => void) | null = null;
    let insertHandler: ((payload: { new: unknown }) => void) | null = null;
    let presenceSync: (() => void) | null = null;
    let latestState: Record<string, unknown[]> = {};

    const channel: ChannelMock = {
      topic,
      config,
      on: vi.fn((type: string, _filter: unknown, callback: unknown) => {
        if (type === "postgres_changes") {
          insertHandler = callback as (payload: { new: unknown }) => void;
        } else if (type === "presence") {
          presenceSync = callback as () => void;
        }
        return channel;
      }),
      subscribe: vi.fn((callback: (status: string) => void) => {
        statusCallback = callback;
        return channel;
      }),
      track: vi.fn(() => Promise.resolve("ok")),
      untrack: vi.fn(() => Promise.resolve("ok")),
      presenceState: vi.fn(() => latestState),
      emitStatus: (status) => statusCallback?.(status),
      emitInsert: (record) => insertHandler?.({ new: record }),
      emitPresenceSync: (state) => {
        latestState = state;
        presenceSync?.();
      },
    };
    return channel;
  }

  function channelWithPrefix(prefix: string): ChannelMock | undefined {
    return [...channels.values()].find((c) => c.topic.startsWith(prefix));
  }

  const profileRow = {
    select: vi.fn(() => profileRow),
    eq: vi.fn(() => profileRow),
    maybeSingle: vi.fn(() =>
      Promise.resolve({ data: { alias: "StudyStar" }, error: null }),
    ),
  };

  const router = { push: vi.fn(), refresh: vi.fn() };

  return {
    router,
    channelFactory: vi.fn((topic: string, config?: unknown) => {
      const channel = createChannel(topic, config);
      channels.set(topic, channel);
      return channel;
    }),
    channelWithPrefix,
    removeChannel: vi.fn(),
    setAuth: vi.fn(() => Promise.resolve()),
    getUser: vi.fn(
      (): Promise<{ data: { user: { id: string } | null }; error: null }> =>
        Promise.resolve({
          data: { user: { id: "44444444-4444-4444-8444-444444444444" } },
          error: null,
        }),
    ),
    profileRow,
    fetchMock: vi.fn(),
    emitStatus: (status: string) =>
      channelWithPrefix("room-messages-")?.emitStatus(status),
    emitInsert: (record: unknown) =>
      channelWithPrefix("room-messages-")?.emitInsert(record),
    resetChannels: () => channels.clear(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: vi.fn(() => mocks.profileRow),
    channel: mocks.channelFactory,
    removeChannel: mocks.removeChannel,
    realtime: { setAuth: mocks.setAuth },
  }),
}));

const ROOM = "11111111-1111-4111-8111-111111111111";
const VIEWER_ID = "44444444-4444-4444-8444-444444444444";

const seeded: ChatMessageView = {
  id: "seed-1",
  alias: "Partner",
  body: "Earlier message",
  created_at: "2026-10-06T07:00:00.000Z",
  status: "sent",
  is_own: false,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deferredResponse() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((outerResolve, outerReject) => {
    resolve = outerResolve;
    reject = outerReject;
  });
  return { promise, resolve, reject };
}

function connectionText(): string {
  // The connection badge is the header status, before the list/composer.
  const statuses = screen.getAllByRole("status");
  return statuses[0]?.textContent ?? "";
}

function messagesChannel() {
  return mocks.channelWithPrefix("room-messages-");
}

function presenceChannel() {
  return mocks.channelWithPrefix("room-presence-");
}

function participantItems(): HTMLElement[] {
  return Array.from(
    screen.getByRole("list", { name: "Participants" }).querySelectorAll("li"),
  );
}

function messageItems(): HTMLElement[] {
  return Array.from(
    screen.getByRole("list", { name: "Chat messages" }).querySelectorAll("li"),
  );
}

function sendMessage(text: string): void {
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

function renderChat(
  props: { initialMessages?: ChatMessageView[]; roomId?: string } = {},
): ReturnType<typeof render> {
  return render(
    <RoomChat
      roomId={props.roomId ?? ROOM}
      initialMessages={props.initialMessages ?? [seeded]}
    />,
  );
}

async function flush(): Promise<void> {
  await act(async () => {});
}

describe("RoomChat", () => {
  beforeEach(() => {
    mocks.resetChannels();
    // The studying flag is module state shared with FocusTimer; a test that
    // publishes it must not leak into the next one.
    publishStudying(false);
    mocks.router.push.mockClear();
    mocks.fetchMock.mockReset();
    // Call-order assertions (token before join) are only meaningful when
    // each test starts with an empty invocation history.
    mocks.setAuth.mockClear();
    mocks.channelFactory.mockClear();
    vi.stubGlobal("fetch", mocks.fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders server-seeded history without a mount-time fetch", async () => {
    renderChat();
    await flush();

    expect(screen.getByText("Earlier message")).toBeTruthy();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(connectionText()).toBe("Connecting…");
  });

  it("shows Live only after the join is acknowledged, and recovers", async () => {
    renderChat();
    await flush();

    act(() => mocks.emitStatus("CHANNEL_ERROR"));
    expect(connectionText()).toBe("Reconnecting…");

    act(() => mocks.emitStatus("SUBSCRIBED"));
    expect(connectionText()).toBe("Live");

    act(() => mocks.emitStatus("TIMED_OUT"));
    expect(connectionText()).toBe("Reconnecting…");

    act(() => mocks.emitStatus("SUBSCRIBED"));
    expect(connectionText()).toBe("Live");
  });

  it("follows the browser's offline and online events", async () => {
    renderChat();
    await flush();

    act(() => mocks.emitStatus("SUBSCRIBED"));
    expect(connectionText()).toBe("Live");

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(connectionText()).toBe("Reconnecting…");

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(connectionText()).toBe("Connecting…");

    act(() => mocks.emitStatus("SUBSCRIBED"));
    expect(connectionText()).toBe("Live");
  });

  it("does not paint Live from an ack that arrives while offline", async () => {
    const original = window.navigator.onLine;
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
    });

    try {
      renderChat();
      await flush();

      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      act(() => mocks.emitStatus("SUBSCRIBED"));

      expect(connectionText()).toBe("Reconnecting…");
    } finally {
      Object.defineProperty(window.navigator, "onLine", {
        value: original,
        configurable: true,
      });
    }
  });

  it("appends realtime messages as they arrive, without a reload", async () => {
    renderChat();
    await flush();
    expect(messageItems()).toHaveLength(1);

    act(() =>
      mocks.emitInsert({
        id: "msg-live-1",
        room_id: ROOM,
        user_id: "55555555-5555-4555-8555-555555555555",
        alias: "Partner",
        body: "Live from a friend",
        created_at: "2026-10-06T07:05:00.000Z",
      }),
    );
    expect(screen.getByText("Live from a friend")).toBeTruthy();

    act(() =>
      mocks.emitInsert({
        id: "msg-live-2",
        room_id: ROOM,
        user_id: VIEWER_ID,
        alias: "StudyStar",
        body: "My own echo",
        created_at: "2026-10-06T07:06:00.000Z",
      }),
    );
    const own = screen.getByText("My own echo").closest("li");
    expect(own?.getAttribute("data-own")).toBe("true");
  });

  it("ignores a duplicate realtime event for a message already shown", async () => {
    renderChat();
    await flush();

    const record = {
      id: "msg-dupe",
      room_id: ROOM,
      user_id: "55555555-5555-4555-8555-555555555555",
      alias: "Partner",
      body: "Once only",
      created_at: "2026-10-06T07:07:00.000Z",
    };

    act(() => mocks.emitInsert(record));
    act(() => mocks.emitInsert(record));

    const matches = messageItems().filter(
      (item) => item.textContent?.includes("Once only"),
    );
    expect(matches).toHaveLength(1);
  });

  it("sends optimistically and swaps in the server's row on 201", async () => {
    renderChat();
    await flush();

    const pending = deferredResponse();
    mocks.fetchMock.mockReturnValueOnce(pending.promise);

    await act(async () => {
      sendMessage("Hello room");
    });

    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(mocks.fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/messages`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "Hello room" }),
      }),
    );

    await act(async () => {
      pending.resolve(
        jsonResponse(201, {
          message: {
            id: "server-1",
            alias: "StudyStar",
            body: "Hello room",
            created_at: "2026-10-06T07:10:00.000Z",
            status: "sent",
            is_own: true,
          },
        }),
      );
      await pending.promise;
    });

    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.getByText("Hello room")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps one copy when realtime confirms the message before the POST does", async () => {
    renderChat();
    await flush();

    const pending = deferredResponse();
    mocks.fetchMock.mockReturnValueOnce(pending.promise);

    await act(async () => {
      sendMessage("Race me");
    });

    act(() =>
      mocks.emitInsert({
        id: "server-race",
        room_id: ROOM,
        user_id: VIEWER_ID,
        alias: "StudyStar",
        body: "Race me",
        created_at: "2026-10-06T07:11:00.000Z",
      }),
    );

    await act(async () => {
      pending.resolve(
        jsonResponse(201, {
          message: {
            id: "server-race",
            alias: "StudyStar",
            body: "Race me",
            created_at: "2026-10-06T07:11:00.000Z",
            status: "sent",
            is_own: true,
          },
        }),
      );
      await pending.promise;
    });

    const copies = messageItems().filter(
      (item) => item.textContent?.includes("Race me"),
    );
    expect(copies).toHaveLength(1);
    expect(screen.queryByText("Sending…")).toBeNull();
  });

  it("marks a rejected send as failed and retries it", async () => {
    renderChat();
    await flush();

    mocks.fetchMock.mockRejectedValueOnce(new Error("network down"));
    await act(async () => {
      sendMessage("Will fail");
    });

    expect(screen.getByText("Not sent.")).toBeTruthy();

    const retry = deferredResponse();
    mocks.fetchMock.mockReturnValueOnce(retry.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(screen.queryByText("Not sent.")).toBeNull();

    await act(async () => {
      retry.resolve(
        jsonResponse(201, {
          message: {
            id: "server-retry",
            alias: "StudyStar",
            body: "Will fail",
            created_at: "2026-10-06T07:12:00.000Z",
            status: "sent",
            is_own: true,
          },
        }),
      );
      await retry.promise;
    });

    expect(screen.queryByText("Not sent.")).toBeNull();
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(mocks.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the viewer to login when a send meets a 401", async () => {
    renderChat();
    await flush();

    mocks.fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: {} }));
    await act(async () => {
      sendMessage("Expired session");
    });

    expect(mocks.router.push).toHaveBeenCalledWith("/auth/login");
  });

  it("keeps participant presence hidden", async () => {
    renderChat();
    await flush();

    // The channel is joined, but until a sync arrives there is no roster to
    // show — and an empty claim would be a lie, not a placeholder.
    expect(presenceChannel()).toBeTruthy();
    expect(screen.queryByText("Participants")).toBeNull();
    expect(screen.queryByRole("list", { name: "Participants" })).toBeNull();
  });

  it("joins a separate private presence channel and tracks the viewer's alias", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    expect(presence?.topic).toBe(presenceChannelTopic(ROOM));
    // RealtimeChannelOptions nests everything under `config`; `private` is
    // what makes the server authorize the join against realtime.messages.
    const options = presence?.config as {
      config?: { private?: boolean };
    };
    expect(options?.config?.private).toBe(true);
    expect(messagesChannel()).toBeTruthy();
    expect(presence).not.toBe(messagesChannel());

    act(() => presence?.emitStatus("SUBSCRIBED"));
    expect(presence?.track).toHaveBeenCalledWith({
      alias: "StudyStar",
      studying: false,
    });
    // The chat badge follows the chat channel only: a presence ack is not a
    // chat ack.
    expect(connectionText()).toBe("Connecting…");
  });

  it("joins the presence channel only after the token is on the client", async () => {
    renderChat();
    await flush();

    const setAuthOrder = mocks.setAuth.mock.invocationCallOrder[0];
    expect(setAuthOrder).toBeDefined();
    // The repo's "auth before join" rule, for both channels: no `channel()`
    // call may precede the registration the join depends on.
    for (const order of mocks.channelFactory.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(setAuthOrder);
    }
    expect(mocks.channelFactory).toHaveBeenCalledTimes(2);
  });

  it("opens no presence channel when there is no session", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    });

    renderChat();
    await flush();

    expect(presenceChannel()).toBeUndefined();
    expect(screen.queryByRole("list", { name: "Participants" })).toBeNull();
    expect(connectionText()).toBe("Reconnecting…");
  });

  it("keeps the roster when the messages channel fails", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    act(() =>
      presence?.emitPresenceSync({
        partner: [{ presence_ref: "1", alias: "Partner", studying: false }],
      }),
    );
    expect(participantItems()).toHaveLength(1);

    // The chat half fails; the roster is a separate surface and must not
    // blank out with it.
    act(() => mocks.emitStatus("CHANNEL_ERROR"));
    expect(connectionText()).toBe("Reconnecting…");
    expect(participantItems()).toHaveLength(1);
    expect(screen.getByText("1 here")).toBeTruthy();
  });

  it("resets the roster when the room changes", async () => {
    const { rerender } = renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    act(() =>
      presence?.emitPresenceSync({
        partner: [{ presence_ref: "1", alias: "Partner", studying: false }],
      }),
    );
    expect(participantItems()).toHaveLength(1);

    const otherRoom = "22222222-2222-4222-8222-222222222222";
    rerender(
      <RoomChat roomId={otherRoom} initialMessages={[seeded]} />,
    );
    await flush();

    // The old room's faces are gone before the new room's join answers:
    // unobserved, not empty-and-stale.
    expect(screen.queryByRole("list", { name: "Participants" })).toBeNull();
    expect(mocks.channelWithPrefix(`room-presence-${otherRoom}`)).toBeTruthy();
  });

  it("renders the roster from a presence sync, viewer's alias first", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    act(() =>
      presence?.emitPresenceSync({
        partner: [{ presence_ref: "1", alias: "Partner", studying: false }],
        self: [{ presence_ref: "2", alias: "StudyStar", studying: false }],
      }),
    );

    expect(participantItems().map((item) => item.textContent)).toEqual([
      "StudyStar",
      "Partner",
    ]);
    expect(screen.getByText("2 here")).toBeTruthy();
    expect(screen.queryByText(/Nobody here but you/)).toBeNull();
  });

  it("marks studying members in the badge and in the count", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    act(() =>
      presence?.emitPresenceSync({
        partner: [{ presence_ref: "1", alias: "Partner", studying: true }],
        self: [{ presence_ref: "2", alias: "StudyStar", studying: false }],
      }),
    );

    expect(screen.getByText("1 studying · 2 here")).toBeTruthy();
    expect(screen.getByText("Partner · studying")).toBeTruthy();
    expect(screen.queryByText("StudyStar · studying")).toBeNull();
  });

  it("shows one badge per alias when the same member is present twice", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    act(() =>
      presence?.emitPresenceSync({
        tabLower: [{ presence_ref: "1", alias: "studystar", studying: false }],
        tabProper: [{ presence_ref: "2", alias: "StudyStar", studying: true }],
        partner: [{ presence_ref: "3", alias: "Partner", studying: false }],
      }),
    );

    const items = participantItems();
    expect(items).toHaveLength(2);
    expect(
      items.filter((item) =>
        item.textContent?.toLowerCase().includes("studystar"),
      ),
    ).toHaveLength(1);
    // Merged: one copy of the member is studying, so the badge says so.
    expect(screen.getByText("1 studying · 2 here")).toBeTruthy();
  });

  it("keeps the last observed roster when the presence channel errors", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    act(() =>
      presence?.emitPresenceSync({
        partner: [{ presence_ref: "1", alias: "Partner", studying: false }],
      }),
    );
    expect(participantItems()).toHaveLength(1);

    act(() => presence?.emitStatus("CHANNEL_ERROR"));
    // The last sync still stands: the roster is never replaced by a guess.
    expect(participantItems()).toHaveLength(1);
    expect(screen.getByText("1 here")).toBeTruthy();
  });

  it("re-tracks immediately when the shared session starts", async () => {
    renderChat();
    await flush();

    const presence = presenceChannel();
    act(() => presence?.emitStatus("SUBSCRIBED"));
    expect(presence?.track).toHaveBeenCalledTimes(1);

    act(() => publishStudying(true));
    expect(presence?.track).toHaveBeenLastCalledWith({
      alias: "StudyStar",
      studying: true,
    });

    act(() => publishStudying(false));
    expect(presence?.track).toHaveBeenLastCalledWith({
      alias: "StudyStar",
      studying: false,
    });
  });

  it("detaches both channels on unmount", async () => {
    const { unmount } = renderChat();
    await flush();

    act(() => mocks.emitStatus("SUBSCRIBED"));
    unmount();

    expect(mocks.removeChannel).toHaveBeenCalledWith(messagesChannel());
    expect(mocks.removeChannel).toHaveBeenCalledWith(presenceChannel());
    // An explicit leave so the server cannot keep a ghost of this viewer.
    expect(presenceChannel()?.untrack).toHaveBeenCalled();
  });
});
