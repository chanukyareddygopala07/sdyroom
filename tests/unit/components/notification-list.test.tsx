// @vitest-environment jsdom
import {
  NotificationEmptyState,
  NotificationRow,
} from "@/components/notifications/notification-list";
import type { NotificationView } from "@/lib/notifications/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function notification(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    type: "muted",
    room_id: "11111111-1111-4111-8111-111111111111",
    payload: {
      title: "You were muted",
      body: "Hidden for an hour.",
      href: "/rooms/11111111-1111-4111-8111-111111111111",
    },
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("NotificationRow", () => {
  it("links to the derived deep link and marks read on click", () => {
    const onRead = vi.fn();
    render(<NotificationRow notification={notification()} onRead={onRead} />);

    const link = screen.getByRole("link", { name: /You were muted/ });
    expect(link.getAttribute("href")).toBe(
      "/rooms/11111111-1111-4111-8111-111111111111",
    );

    fireEvent.click(link);
    expect(onRead).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("exposes an exact machine-readable timestamp next to the relative one", () => {
    const created = "2026-10-10T10:00:00.000000+00:00";
    render(<NotificationRow notification={notification({ created_at: created })} />);

    const time = document.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(created);
    // Relative, not the raw timestamp — the exact value lives in dateTime.
    expect(time?.textContent).toMatch(/ago|just now/);
  });

  it("marks unread rows so the list can style them, read ones not", () => {
    const { rerender } = render(
      <NotificationRow notification={notification({ read_at: null })} />,
    );
    expect(screen.getByTestId("notification-row").getAttribute("data-unread")).toBe("true");

    rerender(
      <NotificationRow
        notification={notification({ read_at: "2026-10-10T10:01:00.000000+00:00" })}
      />,
    );
    expect(screen.getByTestId("notification-row").getAttribute("data-unread")).toBe("false");
  });
});

describe("NotificationEmptyState", () => {
  it("renders the message as status text the list can rely on", () => {
    render(<NotificationEmptyState message="You're all caught up." />);
    expect(screen.getByTestId("notifications-empty").textContent).toBe(
      "You're all caught up.",
    );
  });
});
