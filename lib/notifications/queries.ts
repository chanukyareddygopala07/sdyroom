import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_NOTIFICATION_PREFS,
  toNotificationView,
  type NotificationPrefs,
  type NotificationView,
} from "./types";
import { encodeCursor, type ListNotificationsQuery } from "./validation";

/**
 * Reader-side queries. Every one goes through RLS (own rows) or through the
 * invoker's-rights count function — there is no service-role path here and
 * no way to ask about another user's inbox, which the integration suite
 * proves from the outside.
 */

export type NotificationListResult = {
  notifications: NotificationView[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
  unreadCount: number;
};

export class NotificationQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationQueryError";
  }
}

export class NotificationNotFoundError extends Error {
  constructor() {
    super("That notification does not exist.");
    this.name = "NotificationNotFoundError";
  }
}

/**
 * One page, newest first. Fetches `limit + 1` rows so `has_more` is exact
 * without a second query; `total` and `unread_count` ride the same call as
 * an exact count and the cheap RPC respectively — the endpoint's contract
 * promises both, and neither is expensive on an inbox-sized table.
 */
export async function listNotifications(
  client: SupabaseClient,
  query: ListNotificationsQuery,
): Promise<NotificationListResult> {
  const { limit, cursor, unread } = query;

  let request = client
    .from("notifications")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (unread) {
    request = request.is("read_at", null);
  }
  if (cursor) {
    // Values are double-quoted: timestamps contain `:` and `+`, which the
    // or-filter grammar would otherwise split on. The cursor is decoded from
    // our own base64 and validated, so a quote cannot appear inside.
    request = request.or(
      `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt."${cursor.id}")`,
    );
  }

  const { data, error, count } = await request;
  if (error) {
    throw new NotificationQueryError(error.message);
  }

  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(toNotificationView);
  const last = page[page.length - 1];

  return {
    notifications: page,
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    total: typeof count === "number" ? count : page.length,
    unreadCount: await countUnreadNotifications(client),
  };
}

/** The badge's read: one indexed count of the caller's own unread rows. */
export async function countUnreadNotifications(
  client: SupabaseClient,
): Promise<number> {
  const { data, error } = await client.rpc("notifications_unread_count");
  if (error) {
    throw new NotificationQueryError(error.message);
  }
  return typeof data === "number" ? data : 0;
}

/**
 * Idempotent mark-read on one own row. A foreign id is filtered out by RLS
 * exactly like a missing one, so the 404 both cases produce is
 * indistinguishable — the endpoint is not an existence oracle.
 */
export async function markNotificationRead(
  client: SupabaseClient,
  notificationId: string,
): Promise<{ read: true; unchanged: boolean }> {
  const { data, error } = await client
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .is("read_at", null)
    .select("id");

  if (error) {
    throw new NotificationQueryError(error.message);
  }
  const updated = Array.isArray(data) && data.length > 0;
  if (updated) {
    return { read: true, unchanged: false };
  }

  const { data: existing, error: lookupError } = await client
    .from("notifications")
    .select("id")
    .eq("id", notificationId)
    .maybeSingle();
  if (lookupError) {
    throw new NotificationQueryError(lookupError.message);
  }
  if (!existing) {
    throw new NotificationNotFoundError();
  }
  return { read: true, unchanged: true };
}

/** Clears every unread row the caller owns; the count is the rows touched. */
export async function markAllNotificationsRead(
  client: SupabaseClient,
): Promise<{ updated: number }> {
  const { data, error } = await client
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null)
    .select("id");

  if (error) {
    throw new NotificationQueryError(error.message);
  }
  const updated = Array.isArray(data) ? data.length : 0;
  return { updated };
}

/**
 * Current preferences, merged over the defaults so callers always see a
 * complete record (and the settings form never renders an empty select).
 */
export async function getNotificationPrefs(
  client: SupabaseClient,
  userId: string,
): Promise<NotificationPrefs> {
  const { data, error } = await client
    .from("profiles")
    .select("notification_prefs")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new NotificationQueryError(error.message);
  }
  const stored =
    data && typeof data.notification_prefs === "object"
      ? (data.notification_prefs as Record<string, string>)
      : {};
  return mergePrefs(stored);
}

/**
 * Partial update: the body's categories are merged over the stored record,
 * so leaving a select untouched leaves that category untouched. Cross-device
 * conflicts are last-write-wins by design (the spec scopes them out).
 */
export async function updateNotificationPrefs(
  client: SupabaseClient,
  userId: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const current = await getNotificationPrefs(client, userId);
  const merged = mergePrefs({ ...current, ...prefs });

  const { data, error } = await client
    .from("profiles")
    .update({ notification_prefs: merged })
    .eq("id", userId)
    .select("notification_prefs")
    .maybeSingle();

  if (error) {
    throw new NotificationQueryError(error.message);
  }
  if (!data) {
    throw new NotificationQueryError("profile update returned no row");
  }
  return mergePrefs(
    data.notification_prefs as Record<string, string>,
  );
}

function mergePrefs(stored: Record<string, string>): NotificationPrefs {
  const merged: Required<NotificationPrefs> = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFS) as (keyof typeof DEFAULT_NOTIFICATION_PREFS)[]) {
    const value = stored[key];
    if (
      value === "all" ||
      value === "mentions_and_invites" ||
      value === "none"
    ) {
      merged[key] = value;
    }
  }
  return merged;
}
