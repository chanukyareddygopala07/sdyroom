"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  NotificationEmptyState,
  NotificationRow,
} from "@/components/notifications/notification-list";
import { createClient } from "@/lib/supabase/client";
import type { NotificationView } from "@/lib/notifications/types";
import { cn } from "@/lib/utils";
import {
  subscribeToNotifications,
  watchNotificationWakeups,
} from "@/lib/notifications/subscribe";

type ListResponse = {
  notifications?: NotificationView[];
  unread_count?: number;
  error?: { message?: string };
};

/**
 * The header bell. The badge count is its own cheap read (never the list),
 * refreshed by a postgres_changes INSERT frame and by the polling fallback
 * — focus and a 60-second interval — so an open tab converges without a
 * manual reload in either mode. The dropdown loads the recent eight on
 * open; the full page at /notifications handles the rest. New arrivals
 * announce themselves through a polite live region, not through motion.
 */
export function NotificationBell({
  userId,
  initialUnreadCount,
}: {
  userId: string;
  initialUnreadCount: number;
}) {
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [recent, setRecent] = useState<NotificationView[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const seenIdsRef = useRef<Set<string>>(new Set());

  const refreshCount = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications/unread-count", {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | { unread_count?: number }
        | null;
      if (body && typeof body.unread_count === "number") {
        setUnreadCount(body.unread_count);
      }
    } catch {
      // Offline or a transient failure: the badge keeps its last value and
      // the next wake-up retries. Never surface an error in the header.
    }
  }, [router]);

  const refreshList = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications?limit=8", {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | ListResponse
        | null;
      if (body?.notifications) {
        setRecent(body.notifications);
        if (typeof body.unread_count === "number") {
          setUnreadCount(body.unread_count);
        }
        // Announce only rows this tab has not already seen, so a refresh
        // does not re-read the inbox aloud.
        const fresh = body.notifications.filter(
          (item) => !seenIdsRef.current.has(item.id),
        );
        body.notifications.forEach((item) => seenIdsRef.current.add(item.id));
        const first = fresh.find((item) => item.read_at === null);
        if (first) {
          setAnnouncement(`New notification: ${first.payload.title}`);
        }
      }
    } catch {
      // Same contract as the count: degrade quietly, retry on the next wake.
    }
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    const controller = new AbortController();
    let unsubscribe: (() => void) | null = null;
    void subscribeToNotifications(
      supabase,
      userId,
      () => {
        void refreshCount();
        void refreshList();
      },
      controller.signal,
    ).then((teardown) => {
      if (controller.signal.aborted) {
        teardown();
        return;
      }
      unsubscribe = teardown;
    });
    const unwatch = watchNotificationWakeups(() => {
      void refreshCount();
    });

    return () => {
      controller.abort();
      unsubscribe?.();
      unwatch();
    };
  }, [userId, refreshCount, refreshList]);

  const markRead = async (id: string) => {
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    } catch {
      void refreshCount();
    }
  };

  const markAllRead = async () => {
    setUnreadCount(0);
    setRecent((rows) =>
      rows?.map((row) => ({ ...row, read_at: row.read_at ?? new Date().toISOString() })) ?? rows,
    );
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
    } catch {
      void refreshCount();
    }
  };

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            void refreshList();
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="relative size-9 p-0"
            aria-label={
              unreadCount > 0
                ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
                : "Notifications, nothing unread"
            }
            data-testid="notification-bell"
          >
            <Bell className="size-4" aria-hidden="true" />
            {unreadCount > 0 ? (
              <span
                className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground"
                aria-hidden="true"
                data-testid="notification-badge"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-0" data-testid="notification-panel">
          <div className="flex items-center justify-between px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unreadCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void markAllRead()}
                data-testid="notifications-mark-all"
              >
                Mark all read
              </Button>
            ) : null}
          </div>
          <DropdownMenuSeparator className="m-0" />
          <div className="max-h-96 overflow-y-auto py-1">
            {recent === null ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : recent.length === 0 ? (
              <NotificationEmptyState message="You're all caught up." />
            ) : (
              recent.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={markRead}
                  className="rounded-none px-3"
                />
              ))
            )}
          </div>
          <DropdownMenuSeparator className="m-0" />
          <div className="p-2">
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link href="/notifications">View all notifications</Link>
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <p
        role="status"
        aria-live="polite"
        className={cn("sr-only")}
      >
        {announcement}
      </p>
    </>
  );
}
