// @vitest-environment jsdom
import { RoomSettingsForm } from "@/components/room-settings-form";
import type { PublicRoom } from "@/lib/rooms/types";
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

const ROOM: PublicRoom = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Calculus Study Room",
  exam_track: "JEE",
  subject: "Mathematics",
  language: "English",
  capacity: 6,
  status: "open",
  shared_goal: "Finish the syllabus.",
  created_at: "2026-01-05T10:00:00.000Z",
};

function submittedBody() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe("RoomSettingsForm", () => {
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

  it("prefills the mutable fields and offers no owner or visibility controls", () => {
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    expect(screen.getByLabelText("Room name")).toHaveValue(
      "Calculus Study Room",
    );
    expect(screen.getByLabelText("Capacity")).toHaveValue(6);
    expect(screen.getByLabelText("Status")).toHaveValue("open");
    expect(screen.getByLabelText("Exam track")).toHaveValue("JEE");
    expect(screen.getByLabelText("Subject")).toHaveValue("Mathematics");
    expect(screen.getByLabelText("Language")).toHaveValue("English");
    expect(screen.getByLabelText("Shared goal")).toHaveValue(
      "Finish the syllabus.",
    );

    // Identity, visibility and timestamps are not part of this form at all.
    expect(screen.queryByLabelText("Visibility")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Created")).not.toBeInTheDocument();
    expect(
      screen.getByText(/capacity can't go below this/i),
    ).toBeInTheDocument();
  });

  it("keeps Save disabled until a field actually changes", () => {
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "Renamed" },
    });

    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("validates locally before any network call", async () => {
    const { container } = render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    fireEvent.change(screen.getByLabelText("Capacity"), {
      target: { value: "0" },
    });
    // Submit the form directly: a real browser would stop an out-of-range
    // number at native constraint validation, so this exercises the schema
    // backstop that runs whenever submit is reached programmatically.
    fireEvent.submit(container.querySelector("form")!);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Check the highlighted fields and try again."),
    ).toBeInTheDocument();
    // Field-level and form-level alerts together.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(
      expect.arrayContaining([
        "Capacity must be at least 1",
        "Check the highlighted fields and try again.",
      ]),
    );
  });

  it("submits the full editable set, clears blanks to null, and reseeds from the saved row", async () => {
    const savedRoom: PublicRoom = {
      ...ROOM,
      name: "Renamed",
      shared_goal: null,
    };
    fetchMock.mockResolvedValue(jsonResponse(200, { room: savedRoom }));
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "  Renamed  " },
    });
    fireEvent.change(screen.getByLabelText("Shared goal"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/rooms/${ROOM.id}`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
    expect(submittedBody()).toEqual({
      name: "Renamed",
      shared_goal: null,
      exam_track: "JEE",
      subject: "Mathematics",
      language: "English",
      capacity: 6,
      status: "open",
    });

    await screen.findByText("Room settings saved.");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Room settings saved.",
    );
    // Baseline reseeded from the response: pristine again, Save disabled,
    // and the cleared goal shows what the server actually stored.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByLabelText("Shared goal")).toHaveValue("");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the capacity floor refusal against the capacity field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "capacity_below_membership",
          message: "Capacity cannot be lower than the current member count (5).",
        },
      }),
    );
    render(<RoomSettingsForm room={ROOM} memberCount={5} />);

    fireEvent.change(screen.getByLabelText("Capacity"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Shown both as the form alert and against the capacity field.
    const hits = await screen.findAllByText(/current member count \(5\)/);
    expect(hits.length).toBeGreaterThan(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("maps server-side field issues onto their fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: "validation",
          message: "Check the highlighted fields and try again.",
          issues: [{ path: "name", message: "That name is too long." }],
        },
      }),
    );
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("That name is too long.")).toBeInTheDocument();
  });

  it("redirects an expired session to login", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: { code: "unauthenticated", message: "Sign in required." },
      }),
    );
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/auth/login"),
    );
  });

  it("tells the owner when the room is already gone", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: { code: "not_found", message: "Gone." },
      }),
    );
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("This room no longer exists."),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a retry message when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("Could not reach the server. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("Cancel discards unsaved edits", () => {
    render(<RoomSettingsForm room={ROOM} memberCount={2} />);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "Something else" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText("Room name")).toHaveValue(
      "Calculus Study Room",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    (window.confirm as ReturnType<typeof vi.fn>).mockRestore();
  });
});
