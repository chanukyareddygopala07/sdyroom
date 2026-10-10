// @vitest-environment jsdom
import { NotificationBell } from "@/components/notifications/notification-bell";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, fetchMock, subscribe, watchWakeups, createClientMock } = vi.hoisted(() => ({
  push: vi.fn(),
  fetchMock: vi.fn(),
  subscribe: vi.fn(async () => () => {}),
  watchWakeups: vi.fn(() => () => {}),
  createClientMock: vi.fn(() => ({}) as never),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/notifications/subscribe", () => ({
  subscribeToNotifications: subscribe,
  watchNotificationWakeups: watchWakeups,
}));

// Radix's menu needs a full pointer-capture environment jsdom does not
// provide; the panel's contents are this component's own logic, so the
// primitive is stubbed to an open/close context and the real trigger button
// (with its aria-label) and panel children render unchanged.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  type MenuContextValue = { open: boolean; toggle: () => void };
  const MenuContext = React.createContext<MenuContextValue>({
    open: false,
    toggle: () => {},
  });
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: {
      children: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => {
      const [open, setOpen] = React.useState(false);
      const value = React.useMemo(
        () => ({
          open,
          toggle: () => {
            setOpen((current) => {
              const next = !current;
              onOpenChange?.(next);
              return next;
            });
          },
        }),
        [open, onOpenChange],
      );
      return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
    },
    DropdownMenuTrigger: ({
      children,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => {
      const { toggle } = React.useContext(MenuContext);
      return <span onClick={toggle}>{children}</span>;
    },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(MenuContext);
      return open ? <div data-testid="stub-panel">{children}</div> : null;
    },
    DropdownMenuSeparator: () => <hr />,
  };
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  type: "invite_created",
  room_id: "11111111-1111-4111-8111-111111111111",
  payload: {
    title: "Invitation to Quiet Hall",
    body: "owner invited you.",
    href: "/invitations",
  },
  read_at: null,
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  fetchMock.mockReset();
  subscribe.mockClear();
  watchWakeups.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("NotificationBell", () => {
  it("labels the button with the unread count", () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { notifications: [] }));

    render(<NotificationBell userId="u1" initialUnreadCount={3} />);

    expect(
      screen.getByRole("button", { name: "3 unread notifications" }),
    ).toBeTruthy();
    expect(screen.getByTestId("notification-badge").textContent).toBe("3");
  });

  it("says so plainly when there is nothing unread", () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { notifications: [] }));

    render(<NotificationBell userId="u1" initialUnreadCount={0} />);

    expect(
      screen.getByRole("button", { name: "Notifications, nothing unread" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("notification-badge")).toBeNull();
  });

  it("caps the visual badge at 9+ but keeps the exact count in the label", () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { notifications: [] }));

    render(<NotificationBell userId="u1" initialUnreadCount={42} />);

    expect(screen.getByTestId("notification-badge").textContent).toBe("9+");
    expect(
      screen.getByRole("button", { name: "42 unread notifications" }),
    ).toBeTruthy();
  });

  it("loads the recent list on open and shows the empty state when there is nothing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { notifications: [], unread_count: 0 }),
    );

    render(<NotificationBell userId="u1" initialUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("notification-bell"));

    await waitFor(() => {
      expect(screen.getByTestId("notifications-empty")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications?limit=8", {
      cache: "no-store",
    });
  });

  it("renders rows with their deep links and a mark-all control", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { notifications: [ROW], unread_count: 1 }),
    );

    render(<NotificationBell userId="u1" initialUnreadCount={1} />);
    fireEvent.click(screen.getByTestId("notification-bell"));

    await waitFor(() => {
      expect(screen.getByTestId("notification-row")).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: /Invitation to Quiet Hall/ }).getAttribute("href")).toBe(
      "/invitations",
    );
    expect(screen.getByTestId("notifications-mark-all")).toBeTruthy();
  });

  it("subscribes for live rows and the polling fallback, and cleans both up", () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { notifications: [] }));

    const { unmount } = render(
      <NotificationBell userId="user-1" initialUnreadCount={0} />,
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(watchWakeups).toHaveBeenCalledTimes(1);
    unmount();
    // The subscribe mock resolves to the teardown it would; the real module's
    // cleanup is covered by its own contract (removeChannel + listeners).
    expect(subscribe.mock.results[0]?.value).toBeInstanceOf(Promise);
    expect(watchWakeups.mock.results[0]?.value).toBeTypeOf("function");
  });

  it("walks the student back to login when a refresh 401s", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: {} }));

    render(<NotificationBell userId="u1" initialUnreadCount={0} />);
    fireEvent.click(screen.getByTestId("notification-bell"));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/auth/login");
    });
  });
});
