import { redirect } from "next/navigation";

import { NotificationsInbox } from "@/components/notifications/notifications-inbox";
import {
  getNotificationPrefs,
  listNotifications,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Notifications · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * The full inbox page. The first page, the badge count and the preferences
 * record are read server-side so the page lands complete; everything after
 * (mark-read, load more, preference saves) goes through the API from the
 * client component below. Signed-out visitors are sent to the login screen
 * before any query runs, the same as the rest of the authenticated app.
 */
export default async function NotificationsPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    redirect("/auth/login");
  }

  // The fetch stays outside the JSX: a failure is logged here and rethrown,
  // and the segment's error boundary (error.tsx) is what the student sees.
  const [page, prefs] = await Promise.all([
    listNotifications(supabase, { limit: 20, cursor: undefined, unread: false }),
    getNotificationPrefs(supabase, data.claims.sub),
  ]).catch((error: unknown) => {
    if (error instanceof NotificationQueryError) {
      console.error("[notifications page] load failed:", error);
    }
    throw error;
  });

  return (
    <NotificationsInbox
      initialNotifications={page.notifications}
      initialHasMore={page.hasMore}
      initialNextCursor={page.nextCursor}
      initialUnreadCount={page.unreadCount}
      initialPrefs={prefs}
    />
  );
}
