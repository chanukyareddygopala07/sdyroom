// @vitest-environment jsdom
import { RoomDeleteControl } from "@/components/room-delete-control";
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

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_NAME = "Calculus Study Room";

function renderControl() {
  return render(<RoomDeleteControl roomId={ROOM_ID} roomName={ROOM_NAME} />);
}

function typeConfirmation(value: string) {
  fireEvent.change(screen.getByLabelText(/type/i), {
    target: { value },
  });
}

describe("RoomDeleteControl", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("states what deletion destroys", () => {
    renderControl();

    expect(
      screen.getByText(/cannot be undone/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/memberships, chat history/i),
    ).toBeInTheDocument();
  });

  it("arms the destructive button only for the exact room name", () => {
    renderControl();
    const button = screen.getByRole("button", {
      name: "Delete room permanently",
    });

    expect(button).toBeDisabled();

    typeConfirmation("Calculus");
    expect(button).toBeDisabled();

    typeConfirmation(ROOM_NAME);
    expect(button).toBeEnabled();
  });

  it("never calls the API while unconfirmed", () => {
    renderControl();

    typeConfirmation("wrong name");
    fireEvent.click(
      screen.getByRole("button", { name: "Delete room permanently" }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes and leaves to discovery on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { deleted: true }));
    renderControl();

    typeConfirmation(ROOM_NAME);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete room permanently" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/rooms/${ROOM_ID}`);
    expect(init.method).toBe("DELETE");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
    expect(refresh).toHaveBeenCalled();
  });

  it("stays on the page and shows the server's message when deletion fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: "cleanup_failed",
          message: "The room's files could not be removed. Please try again.",
        },
      }),
    );
    renderControl();

    typeConfirmation(ROOM_NAME);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete room permanently" }),
    );

    expect(
      await screen.findByText(
        "The room's files could not be removed. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    // Still armed, so the owner can retry the converging cleanup.
    expect(
      screen.getByRole("button", { name: "Delete room permanently" }),
    ).toBeEnabled();
  });

  it("treats a 404 as already deleted and leaves", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: { code: "not_found", message: "Gone." },
      }),
    );
    renderControl();

    typeConfirmation(ROOM_NAME);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete room permanently" }),
    );

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
  });

  it("redirects an expired session to login", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: "unauthenticated", message: "Sign in required." },
      }),
    );
    renderControl();

    typeConfirmation(ROOM_NAME);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete room permanently" }),
    );

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });

  it("shows a network message when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderControl();

    typeConfirmation(ROOM_NAME);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete room permanently" }),
    );

    expect(
      await screen.findByText("Could not reach the server. Please try again."),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
