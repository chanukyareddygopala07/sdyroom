// @vitest-environment jsdom
import { RoomCard } from "@/components/room-card";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function summary(
  overrides: Partial<{
    viewer_membership: "none" | "member" | "owner";
    member_count: number;
    status: string;
  }> = {},
) {
  return {
    id: ROOM_ID,
    name: "Calculus Study Room",
    exam_track: "JEE",
    subject: "Mathematics",
    language: "English",
    capacity: 4,
    status: "open",
    shared_goal: "Finish the syllabus.",
    created_at: "2026-01-05T10:00:00.000Z",
    member_count: 1,
    viewer_membership: "none" as const,
    ...overrides,
  };
}

describe("RoomCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("links a member into the workspace", () => {
    render(<RoomCard room={summary({ viewer_membership: "member" })} />);

    const enter = screen.getByRole("link", { name: "Enter room" });
    expect(enter).toHaveAttribute("href", `/rooms/${ROOM_ID}`);
    expect(
      screen.getByRole("button", { name: `Leave Calculus Study Room` }),
    ).toBeInTheDocument();
  });

  it("links the owner into the workspace", () => {
    render(<RoomCard room={summary({ viewer_membership: "owner" })} />);

    const enter = screen.getByRole("link", { name: "Enter room" });
    expect(enter).toHaveAttribute("href", `/rooms/${ROOM_ID}`);
    expect(screen.getByText("You own this room.")).toBeInTheDocument();
  });

  it("shows no workspace link before the viewer has joined", () => {
    render(<RoomCard room={summary({ viewer_membership: "none" })} />);

    expect(
      screen.queryByRole("link", { name: "Enter room" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Join Calculus Study Room" }),
    ).toBeInTheDocument();
  });
});
