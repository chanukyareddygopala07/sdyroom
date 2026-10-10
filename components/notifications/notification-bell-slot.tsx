import { NotificationBell } from "@/components/notifications/notification-bell";
import { countUnreadNotifications } from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side mount point for the bell: it disappears for signed-out
 * visitors (who would only meet a login bounce) and arrives with the count
 * already filled in, so the badge does not flash empty on first paint. The
 * session read is why the shell mounts this inside `<Suspense>`, the same
 * pattern the account controls use. A failed count read renders the bell at
 * zero — the client subscription and the polling fallback correct it within
 * a moment, and the header must never block on a query.
 */
export async function NotificationBellSlot() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return null;
  }

  let unreadCount = 0;
  try {
    unreadCount = await countUnreadNotifications(supabase);
  } catch {
    unreadCount = 0;
  }

  return (
    <NotificationBell userId={data.claims.sub} initialUnreadCount={unreadCount} />
  );
}
