// @vitest-environment jsdom
import { RoomCreateForm } from "@/components/room-create-form";
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

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Room name"), {
    target: { value: "Calculus Study Room" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create room" }));
}

function submittedBody() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe("RoomCreateForm", () => {
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

  it("renders every room field with a label", () => {
    render(<RoomCreateForm />);

    for (const label of [
      "Room name",
      "Capacity",
      "Visibility",
      "Exam track",
      "Subject",
      "Language",
      "Shared goal",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Capacity")).toHaveValue(4);
    expect(screen.getByRole("button", { name: "Create room" })).toBeEnabled();
  });

  it("submits the room payload and returns to discovery", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { room: { id: "room-1", name: "Calculus" } }),
    );
    render(<RoomCreateForm />);

    fillAndSubmit();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/rooms"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/rooms");
    expect(submittedBody()).toEqual({
      name: "Calculus Study Room",
      capacity: "4",
      visibility: "public",
      exam_track: "",
      subject: "",
      language: "",
      shared_goal: "",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("maps API validation issues onto the offending field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: "validation",
          message: "Check the highlighted fields and try again.",
          issues: [
            { path: "capacity", message: "Capacity must be at least 1" },
          ],
        },
      }),
    );
    render(<RoomCreateForm />);

    fillAndSubmit();

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((alert) =>
        alert.textContent?.includes("Capacity must be at least 1"),
      ),
    ).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it("sends a user without a profile to onboarding", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: "onboarding_required", message: "Choose an alias" },
      }),
    );
    render(<RoomCreateForm />);

    fillAndSubmit();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
  });

  it("reports a network failure without navigating", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<RoomCreateForm />);

    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server. Please try again.",
    );
    expect(push).not.toHaveBeenCalled();
  });
});
