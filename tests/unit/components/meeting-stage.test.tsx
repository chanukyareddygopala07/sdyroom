// @vitest-environment jsdom
import { MeetingStage } from "@/components/meeting/meeting-stage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RoomViewProps = {
  url: string;
  token: string;
  canPublishMic: boolean;
  onConnected: () => void;
  onDisconnected: (message: string) => void;
  onError: (message: string) => void;
  onLeave: () => void;
};

const { MeetingRoomView } = vi.hoisted(() => ({
  MeetingRoomView: vi.fn((props: RoomViewProps) => {
    void props;
    return null;
  }),
}));

vi.mock("@/components/meeting/meeting-room-view", () => ({
  MeetingRoomView,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const credentials = {
  token: "signed-token",
  url: "wss://example.livekit.cloud",
  room: `sdyroom-${ROOM_ID}`,
  identity: "user-1",
  expires_in: 600,
  can_publish_mic: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastRoomViewProps(): RoomViewProps {
  const calls = MeetingRoomView.mock.calls;
  const props = calls[calls.length - 1]?.[0];
  if (!props) {
    throw new Error("MeetingRoomView was never rendered");
  }
  return props;
}

describe("MeetingStage", () => {
  beforeEach(() => {
    MeetingRoomView.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows an honest unavailable card when the server has no provider", () => {
    const onLeave = vi.fn();
    render(
      <MeetingStage
        roomId={ROOM_ID}
        meetingConfigured={false}
        onLeave={onLeave}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Live meetings are unavailable" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join meeting" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to studying" }));
    expect(onLeave).toHaveBeenCalled();
  });

  it("requests a token for exactly this room and mounts the room view", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(jsonResponse(credentials));

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    expect(await screen.findByText("Joining…")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM_ID}/meeting/token`,
      expect.objectContaining({ method: "POST" }),
    );

    const props = await vi.waitFor(() => lastRoomViewProps());
    expect(props.url).toBe(credentials.url);
    expect(props.token).toBe(credentials.token);
    expect(props.canPublishMic).toBe(true);
  });

  it("carries a muted grant through to the room view", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ ...credentials, can_publish_mic: false }),
    );

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    const props = await vi.waitFor(() => lastRoomViewProps());
    expect(props.canPublishMic).toBe(false);
  });

  it("maps a 404 to the access-loss message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ error: { code: "not_found" } }, 404),
    );

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    expect(
      await screen.findByText("You no longer have access to this room."),
    ).toBeTruthy();
    expect(MeetingRoomView).not.toHaveBeenCalled();
  });

  it("maps a 503 to the not-configured message", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ error: { code: "meeting_unavailable" } }, 503),
    );

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    expect(
      await screen.findByText(
        "Live meetings aren't set up on this server yet.",
      ),
    ).toBeTruthy();
  });

  it("explains a network failure instead of showing a raw error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    expect(
      await screen.findByText(
        "We couldn't reach the server. Check your connection and try again.",
      ),
    ).toBeTruthy();
  });

  it("rejects a malformed 200 body rather than connecting with junk", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ unexpected: true }),
    );

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    expect(
      await screen.findByText(
        "The server sent an unexpected meeting response. Please try again.",
      ),
    ).toBeTruthy();
    expect(MeetingRoomView).not.toHaveBeenCalled();
  });

  it("returns to the join card with a notice when the meeting ends on its own", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(credentials));

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));
    const props = await vi.waitFor(() => lastRoomViewProps());

    props.onDisconnected("The meeting ended.");

    expect(await screen.findByText("The meeting ended.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Join meeting" }),
    ).toBeTruthy();
  });

  it("shows the connection error and offers a retry", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(credentials));

    render(
      <MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));
    const props = await vi.waitFor(() => lastRoomViewProps());

    props.onError("We couldn't connect to the meeting (timeout).");

    expect(
      await screen.findByText("We couldn't connect to the meeting (timeout)."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });

  it("leaves the meeting back to study mode through the room view", async () => {
    const onLeave = vi.fn();
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse(credentials));

    render(<MeetingStage roomId={ROOM_ID} meetingConfigured onLeave={onLeave} />);
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));
    const props = await vi.waitFor(() => lastRoomViewProps());

    props.onLeave();
    expect(onLeave).toHaveBeenCalled();
  });
});
