// @vitest-environment jsdom
import { GoalsPanel } from "@/components/goals-panel";
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

const ROOM = "11111111-1111-4111-8111-111111111111";
const GOAL_ID = "44444444-4444-4444-8444-444444444444";

const activeGoal = {
  id: GOAL_ID,
  room_id: ROOM,
  title: "Finish chapter 4",
  target_seconds: 1500,
  target_count: 10,
  status: "active" as const,
  completed_at: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("GoalsPanel", () => {
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

  it("renders the caller's goals with their targets", () => {
    render(<GoalsPanel roomId={ROOM} initialGoals={[activeGoal]} />);

    expect(screen.getByText("Finish chapter 4")).toBeInTheDocument();
    expect(screen.getByText("25 min · 10 ×")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete" })).toBeInTheDocument();
  });

  it("explains an empty list without showing anyone else's goals", () => {
    render(<GoalsPanel roomId={ROOM} initialGoals={[]} />);

    expect(
      screen.getByText(/No goals yet\. Add one above — only you can see it\./),
    ).toBeInTheDocument();
  });

  it("creates a goal, converting minutes to seconds", async () => {
    const created = {
      ...activeGoal,
      id: "55555555-5555-4555-8555-555555555555",
      title: "Revise thermodynamics",
      target_seconds: 2700,
      target_count: null,
    };
    fetchMock.mockResolvedValue(jsonResponse(201, { goal: created }));

    render(<GoalsPanel roomId={ROOM} initialGoals={[]} />);
    fireEvent.change(screen.getByLabelText("Goal title"), {
      target: { value: "Revise thermodynamics" },
    });
    fireEvent.change(screen.getByLabelText("Target time in minutes"), {
      target: { value: "45" },
    });
    await waitFor(() =>
      fireEvent.click(screen.getByRole("button", { name: "Add goal" })),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/rooms/${ROOM}/goals`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: "Revise thermodynamics",
            target_seconds: 2700,
          }),
        }),
      ),
    );
    expect(await screen.findByText("Revise thermodynamics")).toBeInTheDocument();
    expect(screen.getByLabelText("Goal title")).toHaveValue("");
    expect(refresh).toHaveBeenCalled();
  });

  it("refuses an out-of-range target before touching the server", async () => {
    render(<GoalsPanel roomId={ROOM} initialGoals={[]} />);
    fireEvent.change(screen.getByLabelText("Goal title"), {
      target: { value: "Anything" },
    });
    fireEvent.change(screen.getByLabelText("Target time in minutes"), {
      target: { value: "99999" },
    });
    // Submit directly: the browser's own `max` check would stop the click
    // first, so this exercises the in-component guard that backs it.
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Target time must be between 1 and 1440 minutes.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("completes a goal through the returned row", async () => {
    const completed = {
      ...activeGoal,
      status: "completed" as const,
      completed_at: "2026-10-06T08:00:00+00:00",
    };
    fetchMock.mockResolvedValue(jsonResponse(200, { goal: completed }));

    render(<GoalsPanel roomId={ROOM} initialGoals={[activeGoal]} />);
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/goals/${GOAL_ID}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "completed" }),
        }),
      ),
    );

    expect(await screen.findByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("deletes a goal and removes the row", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { deleted: true }));

    render(<GoalsPanel roomId={ROOM} initialGoals={[activeGoal]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete goal Finish chapter 4" }));

    await waitFor(() => expect(screen.queryByText("Finish chapter 4")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/goals/${GOAL_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the server's message when the goal is not the caller's", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: {
          code: "not_found",
          message: "That goal does not exist or is not available.",
        },
      }),
    );

    render(<GoalsPanel roomId={ROOM} initialGoals={[activeGoal]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete goal Finish chapter 4" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That goal does not exist or is not available.",
    );
    // The row stays: nothing was actually deleted.
    expect(screen.getByText("Finish chapter 4")).toBeInTheDocument();
  });

  it("sends the viewer to login when the session is gone", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: "unauthenticated" } }),
    );

    render(<GoalsPanel roomId={ROOM} initialGoals={[activeGoal]} />);
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/login"));
  });

  it("reports a lost connection without changing the list", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    render(<GoalsPanel roomId={ROOM} initialGoals={[activeGoal]} />);
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the server. Please try again.",
    );
    expect(screen.getByText("Finish chapter 4")).toBeInTheDocument();
  });
});
