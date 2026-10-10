/**
 * Notification domain types — the wire shape the reader API and the UI share,
 * plus the type→category and type→href tables every producer and reviewer
 * must follow (docs/API_CONTRACTS.md holds the same table as the published
 * contract; this file is its single implementation).
 */

export const NOTIFICATION_TYPES = [
  "invite_created",
  "invite_accepted",
  "member_removed",
  "muted",
  "moderation_resolved",
  "report_resolved",
  "resource_ready",
  "ai_task_complete",
  "system",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CATEGORIES = [
  "invite",
  "moderation",
  "ai",
  "resource",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Type → preference category. `system` is deliberately absent from the map —
 * its category is `null` in the database function too, which is how "system
 * notifications are not configurable" is expressed in one place each.
 */
export const NOTIFICATION_CATEGORY_BY_TYPE: Record<
  NotificationType,
  NotificationCategory | null
> = {
  invite_created: "invite",
  invite_accepted: "invite",
  member_removed: "moderation",
  muted: "moderation",
  moderation_resolved: "moderation",
  report_resolved: "moderation",
  resource_ready: "resource",
  ai_task_complete: "ai",
  system: null,
};

export const PREF_VALUES = ["all", "mentions_and_invites", "none"] as const;

export type NotificationPrefValue = (typeof PREF_VALUES)[number];

export type NotificationPrefs = Partial<
  Record<NotificationCategory | "default", NotificationPrefValue>
>;

/** What a missing key resolves to, and what the settings form shows. */
export const DEFAULT_NOTIFICATION_PREFS: Required<NotificationPrefs> = {
  default: "all",
  invite: "all",
  moderation: "all",
  ai: "all",
  resource: "all",
};

/** Stored payload — titles and bodies are built by trusted producers only. */
export type NotificationPayload = {
  title: string;
  body: string;
};

/**
 * One row as the API returns it. `href` rides *inside* `payload` — the
 * published contract's shape — but is still derived at read time, never
 * stored: a route rename cannot leave months of stale rows pointing at 404s.
 */
export type NotificationView = {
  id: string;
  type: NotificationType;
  room_id: string | null;
  payload: NotificationPayload & { href: string };
  read_at: string | null;
  created_at: string;
};

/**
 * Deep link per type. Derived at read time instead of stored in `payload` so
 * a route rename cannot leave months of stale rows pointing at 404s — the
 * table in docs/API_CONTRACTS.md is the contract, and this map is the only
 * place it is enforced. An absent `room_id` degrades to the section index
 * rather than a dead link.
 */
export function hrefForNotification(
  type: NotificationType,
  roomId: string | null,
): string {
  switch (type) {
    case "invite_created":
    case "invite_accepted":
      return "/invitations";
    case "member_removed":
      return "/rooms";
    case "muted":
    case "moderation_resolved":
    case "report_resolved":
      return roomId ? `/rooms/${roomId}` : "/rooms";
    case "resource_ready":
      return "/resources";
    case "ai_task_complete":
      return roomId ? `/rooms/${roomId}` : "/rooms";
    case "system":
      return "/";
  }
}

/**
 * Maps a database row to the API view. Defensive by design: the row arrives
 * over PostgREST and a malformed payload must not take the list endpoint
 * down, so anything unexpected degrades to an empty title/body pair.
 */
export function toNotificationView(row: Record<string, unknown>): NotificationView {
  const type = String(row.type) as NotificationType;
  const roomId = typeof row.room_id === "string" ? row.room_id : null;
  const rawPayload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const title = typeof rawPayload.title === "string" ? rawPayload.title : "";
  const body = typeof rawPayload.body === "string" ? rawPayload.body : "";

  return {
    id: String(row.id),
    type,
    room_id: roomId,
    payload: { title, body, href: hrefForNotification(type, roomId) },
    read_at: typeof row.read_at === "string" ? row.read_at : null,
    created_at: String(row.created_at),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time for the inbox rows ("just now", "5m ago", "3h ago",
 * "2d ago"); older rows show their date, since a third "wks ago" bucket adds
 * no information the date does not. `<time dateTime>` always carries the
 * exact instant for assistive technology.
 */
export function formatRelativeTime(
  value: string | Date,
  now: Date = new Date(),
): string {
  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) {
    return "";
  }

  const elapsed = now.getTime() - then.getTime();
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 7 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }

  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
