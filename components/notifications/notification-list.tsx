"use client";

import Link from "next/link";

import { NotificationTypeIcon } from "@/components/notifications/notification-icons";
import { cn } from "@/lib/utils";
import {
  formatRelativeTime,
  type NotificationView,
} from "@/lib/notifications/types";

/**
 * Row + empty state, shared by the header dropdown and the full inbox page.
 * Clicking a row marks it read (the navigation continues either way — a
 * failed mark-read is re-synced by the next list fetch, never blocking the
 * deep link). `<time dateTime>` carries the exact instant; the visible text
 * is the compact relative form.
 */
export function NotificationRow({
  notification,
  onRead,
  className,
}: {
  notification: NotificationView;
  onRead?: (id: string) => void;
  className?: string;
}) {
  const unread = notification.read_at === null;

  return (
    <Link
      href={notification.payload.href}
      onClick={() => onRead?.(notification.id)}
      className={cn(
        "flex items-start gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        unread && "bg-accent/40",
        className,
      )}
      data-testid="notification-row"
      data-unread={unread ? "true" : "false"}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          unread
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
        )}
      >
        <NotificationTypeIcon type={notification.type} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate",
              unread ? "font-medium text-foreground" : "text-foreground",
            )}
          >
            {notification.payload.title}
          </span>
          <time
            dateTime={notification.created_at}
            className="shrink-0 text-xs text-muted-foreground"
          >
            {formatRelativeTime(notification.created_at)}
          </time>
        </span>
        <span className="mt-0.5 line-clamp-2 text-muted-foreground">
          {notification.payload.body}
        </span>
      </span>
      {unread ? (
        <span
          className="mt-2 size-2 shrink-0 rounded-full bg-primary"
          aria-hidden="true"
        />
      ) : null}
    </Link>
  );
}

export function NotificationEmptyState({ message }: { message: string }) {
  return (
    <p className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="notifications-empty">
      {message}
    </p>
  );
}
