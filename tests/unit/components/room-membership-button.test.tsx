// @vitest-environment jsdom
import { RoomMembershipButton } from "@/components/room-membership-button";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refresh, fetchMock } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const props = {
  roomId: "11111111-1111-4111-8111-111111111111",
  roomName: "Calculus Study Room",
  viewerMembership: "none" as const,
  isFull: false,
  isClosed: false,
};

describe("RoomMembershipButton", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts to the join endpoint when a non-member joins an open room", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { membership: "joined", member_count: 3 }),
    );
    render(<RoomMembershipButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Join Calculus Study Room" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${props.roomId}/join`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("blocks a second click while the request is in flight", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<RoomMembershipButton {...props} />);
    const button = screen.getByRole("button", { name: /Join/ });

    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(screen.getByText("Joining...")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a room the viewer belongs to", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { membership: "left", member_count: 2 }),
    );
    render(<RoomMembershipButton {...props} viewerMembership="member" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Leave Calculus Study Room" }),
    );

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${props.roomId}/leave`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends the viewer to login when the session is gone", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: "unauthenticated" } }),
    );
    render(<RoomMembershipButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Join/ }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the server's message when the room fills up", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: { code: "room_full", message: "This room is full." } }),
    );
    render(<RoomMembershipButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Join/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This room is full.",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a lost connection without claiming the room changed", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<RoomMembershipButton {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Join/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server. Please try again.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("explains that a full room offers no join", () => {
    render(<RoomMembershipButton {...props} isFull />);

    expect(screen.getByText("Room is full.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains that a closed room offers no join", () => {
    render(<RoomMembershipButton {...props} isClosed />);

    expect(screen.getByText("Room is closed.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("tells the owner they cannot leave", () => {
    render(<RoomMembershipButton {...props} viewerMembership="owner" />);

    expect(screen.getByText("You own this room.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
