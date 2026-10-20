// @vitest-environment jsdom
import { RoomWorkspace } from "@/components/room-workspace";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/meeting/meeting-stage", () => ({
  MeetingStage: ({
    roomId,
    onLeave,
  }: {
    roomId: string;
    onLeave: () => void;
  }) => (
    <div>
      <span data-testid="stage-room">{roomId}</span>
      <button type="button" onClick={onLeave}>
        Stage leave
      </button>
    </div>
  ),
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function renderWorkspace(meetingConfigured = true) {
  return render(
    <RoomWorkspace
      roomId={ROOM_ID}
      meetingConfigured={meetingConfigured}
      rail={<p>rail-panel</p>}
      studyMain={<p>timer-and-goals</p>}
      chat={<p>chat-panel</p>}
      resources={<p>resources-panel</p>}
      artifacts={<p>artifacts-panel</p>}
    />,
  );
}

describe("RoomWorkspace", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts in study mode with every panel visible", () => {
    renderWorkspace();

    expect(screen.getByText("rail-panel")).toBeTruthy();
    expect(screen.getByText("timer-and-goals")).toBeTruthy();
    expect(screen.getByText("chat-panel")).toBeTruthy();
    expect(screen.getByText("resources-panel")).toBeTruthy();
    expect(screen.getByText("artifacts-panel")).toBeTruthy();
    expect(screen.queryByTestId("stage-room")).toBeNull();
  });

  it("switches to the meeting view and back without unmounting the chat", () => {
    renderWorkspace();
    const chat = screen.getByText("chat-panel");

    fireEvent.click(screen.getByRole("button", { name: "Meeting" }));

    expect(screen.getByTestId("stage-room")).toHaveProperty(
      "textContent",
      ROOM_ID,
    );
    // jsdom has no stylesheet, so the display toggle is asserted as the
    // `hidden` class on each study-only wrapper.
    expect(
      screen.getByText("rail-panel").parentElement?.className,
    ).toContain("hidden");
    expect(
      screen.getByText("timer-and-goals").parentElement?.className,
    ).toContain("hidden");
    expect(
      screen.getByText("resources-panel").parentElement?.className,
    ).toContain("hidden");
    expect(
      screen.getByText("artifacts-panel").parentElement?.className,
    ).toContain("hidden");
    // The room chat is the meeting's text channel: same node, still visible.
    expect(screen.getByText("chat-panel")).toBe(chat);
    expect(screen.getByText("chat-panel").parentElement?.className ?? "").not.toContain("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Study" }));

    expect(screen.queryByTestId("stage-room")).toBeNull();
    expect(screen.getByText("rail-panel")).toBeTruthy();
    expect(screen.getByText("chat-panel")).toBe(chat);
  });

  it("returns to study mode when the stage asks to leave", () => {
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "Meeting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage leave" }));

    expect(screen.queryByTestId("stage-room")).toBeNull();
    expect(screen.getByText("timer-and-goals")).toBeTruthy();
  });

  it("marks the view toggle with aria-pressed", () => {
    renderWorkspace();

    const study = screen.getByRole("button", { name: "Study" });
    const meeting = screen.getByRole("button", { name: "Meeting" });
    expect(study.getAttribute("aria-pressed")).toBe("true");
    expect(meeting.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(meeting);
    expect(study.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Meeting" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("disables the meeting view with an explanation when unconfigured", () => {
    renderWorkspace(false);

    const meeting = screen.getByRole("button", { name: "Meeting" }) as HTMLButtonElement;
    expect(meeting.disabled).toBe(true);
    expect(meeting.getAttribute("title")).toBe(
      "Live meetings are not configured on this server yet.",
    );
  });
});
