"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  NotificationEmptyState,
  NotificationRow,
} from "@/components/notifications/notification-list";
import { PreferencesForm } from "@/components/notifications/preferences-form";
import type {
  NotificationPrefs,
  NotificationView,
} from "@/lib/notifications/types";
import { cn } from "@/lib/utils";

type ListApiResponse = {
  notifications?: NotificationView[];
  has_more?: boolean;
  next_cursor?: string | null;
  unread_count?: number;
  error?: { message?: string };
};

/**
 * The full inbox: the server's first page plus cursor "load more", the same
 * rows the dropdown uses, and the preferences form PR 20 will absorb. All
 * state updates go through the real endpoints — this component owns no
 * cached truth beyond what it has fetched — and a 401 mid-session walks the
 * student back to the login screen the way every other client surface does.
 */
export function NotificationsInbox({
  initialNotifications,
  initialHasMore,
  initialNextCursor,
  initialUnreadCount,
  initialPrefs,
}: {
  initialNotifications: NotificationView[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  initialUnreadCount: number;
  initialPrefs: NotificationPrefs;
}) {
  const router = useRouter();
  const [notifications, setNotifications] =
    useState<NotificationView[]>(initialNotifications);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications?limit=20", {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | ListApiResponse
        | null;
      if (!body?.notifications) return;
      setNotifications(body.notifications);
      setHasMore(Boolean(body.has_more));
      setNextCursor(body.next_cursor ?? null);
      if (typeof body.unread_count === "number") {
        setUnreadCount(body.unread_count);
      }
    } catch {
      // A failed refresh leaves the current page in place; the next user
      // action retries rather than replacing the list with an error.
    }
  }, [router]);

  const markRead = async (id: string) => {
    setNotifications((rows) =>
      rows.map((row) =>
        row.id === id && row.read_at === null
          ? { ...row, read_at: new Date().toISOString() }
          : row,
      ),
    );
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    } catch {
      void refresh();
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    const stamp = new Date().toISOString();
    setNotifications((rows) =>
      rows.map((row) => (row.read_at === null ? { ...row, read_at: stamp } : row)),
    );
    setUnreadCount(0);
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
    } catch {
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/notifications?limit=20&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store" },
      );
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | ListApiResponse
        | null;
      if (body?.notifications) {
        setNotifications((rows) => [...rows, ...body.notifications!]);
        setHasMore(Boolean(body.has_more));
        setNextCursor(body.next_cursor ?? null);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="inbox-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 id="inbox-heading" className="text-2xl font-semibold">
            Notifications
          </h1>
          {unreadCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void markAllRead()}
              disabled={busy}
              data-testid="inbox-mark-all"
            >
              Mark all read
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground" data-testid="inbox-unread">
          {unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
            : "Nothing unread."}
        </p>

        <div className="flex flex-col rounded-lg border">
          {notifications.length === 0 ? (
            <NotificationEmptyState message="Nothing here yet — invitations, moderation actions, and processing updates will appear as they happen." />
          ) : (
            notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onRead={markRead}
                className={cn("rounded-none border-b last:border-b-0")}
              />
            ))
          )}
        </div>

        {hasMore ? (
          <Button
            variant="ghost"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="inbox-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </section>

      <PreferencesForm initialPrefs={initialPrefs} />
    </div>
  );
}
