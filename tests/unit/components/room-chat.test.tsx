// @vitest-environment jsdom
import { RoomChat } from "@/components/room-chat";
import type { ChatMessageView } from "@/lib/chat/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let statusCallback: ((status: string) => void) | null = null;
  let insertHandler: ((payload: { new: unknown }) => void) | null = null;

  const channel = {
    on: vi.fn(
      (
        _type: string,
        _filter: unknown,
        callback: (payload: { new: unknown }) => void,
      ) => {
        insertHandler = callback;
        return channel;
      },
    ),
    subscribe: vi.fn((callback: (status: string) => void) => {
      statusCallback = callback;
      return channel;
    }),
  };

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
    channel,
    channelFactory: vi.fn(() => channel),
    removeChannel: vi.fn(),
    setAuth: vi.fn(() => Promise.resolve()),
    getUser: vi.fn(() =>
      Promise.resolve({
        data: { user: { id: "44444444-4444-4444-8444-444444444444" } },
        error: null,
      }),
    ),
    profileRow,
    fetchMock: vi.fn(),
    emitStatus: (status: string) => statusCallback?.(status),
    emitInsert: (record: unknown) => insertHandler?.({ new: record }),
    resetChannels: () => {
      statusCallback = null;
      insertHandler = null;
    },
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
  props: { initialMessages?: ChatMessageView[] } = {},
): ReturnType<typeof render> {
  return render(
    <RoomChat
      roomId={ROOM}
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
    mocks.router.push.mockClear();
    mocks.fetchMock.mockReset();
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

    expect(screen.queryByText("Participants")).toBeNull();
    expect(screen.queryByRole("list", { name: "Participants" })).toBeNull();
  });

  it("detaches the channel on unmount", async () => {
    const { unmount } = renderChat();
    await flush();

    act(() => mocks.emitStatus("SUBSCRIBED"));
    unmount();

    expect(mocks.removeChannel).toHaveBeenCalledWith(mocks.channel);
  });
});
