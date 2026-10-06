// @vitest-environment jsdom
import { FocusTimer } from "@/components/focus-timer";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, fetchMock, channel, removeChannel, setAuth } = vi.hoisted(() => {
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      callback?.("SUBSCRIBED");
      return channel;
    }),
  };
  return {
    push: vi.fn(),
    fetchMock: vi.fn(),
    channel,
    removeChannel: vi.fn(),
    setAuth: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: vi.fn(() => channel),
    removeChannel,
    realtime: { setAuth },
  }),
}));

const ROOM = "11111111-1111-4111-8111-111111111111";
const START = new Date("2026-10-06T07:00:00.000Z").getTime();

type TimerSession = {
  id: string;
  room_id: string;
  state: "running" | "paused" | "completed" | "expired";
  duration_seconds: number;
  started_at: string;
  ends_at: string;
  paused_at: string | null;
  paused_seconds: number;
  ended_at: string | null;
};

const runningSession: TimerSession = {
  id: "22222222-2222-4222-8222-222222222222",
  room_id: ROOM,
  state: "running" as const,
  duration_seconds: 1500,
  started_at: new Date(START).toISOString(),
  ends_at: new Date(START + 90_000).toISOString(),
  paused_at: null,
  paused_seconds: 0,
  ended_at: null,
};

const pausedSession = {
  ...runningSession,
  state: "paused" as const,
  paused_at: new Date(START + 30_000).toISOString(),
};

const completedHistory = {
  id: "33333333-3333-4333-8333-333333333333",
  room_id: ROOM,
  state: "completed" as const,
  duration_seconds: 2700,
  started_at: new Date(START - 3_600_000).toISOString(),
  ends_at: new Date(START - 900_000).toISOString(),
  paused_at: null,
  paused_seconds: 120,
  ended_at: new Date(START - 910_000).toISOString(),
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function workspaceResponse() {
  return workspaceResponseWith(runningSession);
}

function workspaceResponseWith(session: TimerSession) {
  return jsonResponse(200, {
    session,
    history: [completedHistory],
    viewer_role: "owner",
    server_now_ms: START,
    member_count: 3,
  });
}

type TimerProps = Partial<React.ComponentProps<typeof FocusTimer>>;

function renderTimer(props: TimerProps = {}) {
  return render(
    <FocusTimer
      roomId={ROOM}
      roomName="Physics sprint"
      initialSession={runningSession}
      initialHistory={[completedHistory]}
      initialRole="owner"
      initialServerNowMs={START}
      {...props}
    />,
  );
}

describe("FocusTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    push.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(workspaceResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the countdown from the server clock, not the local one", () => {
    renderTimer();

    expect(screen.getByText("1:30")).toBeInTheDocument();
    expect(screen.getByText(/1500 min session|25 min session/)).toBeInTheDocument();
  });

  it("never shows more time than the session was granted, even when the clock lags", () => {
    // The display clock advances once a second, so right after a start it can
    // read up to a tick behind the server: the raw delta is 25:01 here.
    renderTimer({
      initialSession: { ...runningSession, ends_at: new Date(START + 1_501_000).toISOString() },
    });

    expect(screen.getByText("25:00")).toBeInTheDocument();
  });

  it("reports the realtime channel as live once subscribed", async () => {
    renderTimer();
    await act(async () => {});

    expect(channel.subscribe).toHaveBeenCalled();
    expect(screen.getByText("Live")).toBeInTheDocument();
    // Auth settles before the join so the filter is registered as the user.
    expect(setAuth.mock.invocationCallOrder[0]).toBeLessThan(
      channel.subscribe.mock.invocationCallOrder[0],
    );
  });

  it("renders recent sessions with their outcome", () => {
    renderTimer();

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText(/45 min/)).toBeInTheDocument();
    expect(screen.getByText(/2 min paused/)).toBeInTheDocument();
  });

  it("shows a frozen countdown while paused", () => {
    renderTimer({ initialSession: pausedSession });

    // ends_at minus paused_at: the remaining time stopped moving.
    expect(screen.getByText("1:00")).toBeInTheDocument();
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
  });

  it("offers preset lengths and a start control to the owner when idle", () => {
    renderTimer({ initialSession: null, initialHistory: [] });

    expect(screen.getByText("No session running.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "25 min" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start 25 min session" }),
    ).toBeInTheDocument();
  });

  it("switches the start label when another preset is chosen", () => {
    renderTimer({ initialSession: null, initialHistory: [] });

    fireEvent.click(screen.getByRole("button", { name: "45 min" }));

    expect(
      screen.getByRole("button", { name: "Start 45 min session" }),
    ).toBeInTheDocument();
  });

  it("starts a session with the selected duration", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, {
      action: "started",
      session: runningSession,
    }));
    renderTimer({ initialSession: null, initialHistory: [] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start 25 min session" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/session/start`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ duration_seconds: 1500 }),
      }),
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("pauses and resumes through the returned session", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        action: "paused",
        session: pausedSession,
      }))
      .mockResolvedValueOnce(workspaceResponseWith(pausedSession));
    renderTimer();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });

    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/session/pause`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("tells students the owner controls the timer", () => {
    renderTimer({ initialRole: "student" });

    expect(
      screen.getByText("The room owner controls this timer."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("explains that only the owner can start a session when idle", () => {
    renderTimer({
      initialRole: "student",
      initialSession: null,
      initialHistory: [],
    });

    expect(
      screen.getByText("The room owner starts and controls the shared timer."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start/ })).not.toBeInTheDocument();
  });

  it("shows the server's message when a control is refused", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: "invalid_state",
          message: "The focus session is not in a state that allows this.",
        },
      }),
    );
    renderTimer({ initialSession: null, initialHistory: [] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The focus session is not in a state that allows this.",
    );
  });

  it("sends the viewer to login when the session is gone", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "unauthenticated" } }),
    );
    renderTimer({ initialSession: null, initialHistory: [] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    });

    expect(push).toHaveBeenCalledWith("/auth/login");
  });

  it("keeps the last snapshot and reports a lost connection", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    renderTimer();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not reach the server. Please try again.",
    );
    expect(screen.getByText("1:30")).toBeInTheDocument();
  });
});
