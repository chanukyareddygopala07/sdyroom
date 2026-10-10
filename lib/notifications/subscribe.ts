import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Live delivery for an open tab.
 *
 * Mode: **postgres_changes on the `notifications` table** — the same
 * mechanism chat already uses for `room_messages` (0011 adds the table to
 * the `supabase_realtime` publication). Delivery is scoped by the
 * subscriber's own SELECT RLS and by a `user_id=eq.<me>` filter, so a frame
 * for another user's row is the same impossibility as reading that row over
 * PostgREST; there is no broadcast channel and no per-user topic
 * authorisation to get wrong. If the socket never comes up the feature still
 * works — `watchNotificationWakeups` below is the polling fallback the spec
 * requires, and every consumer treats a missed frame as "refresh later",
 * never as "nothing happened".
 */

const POLL_INTERVAL_MS = 60_000;

/**
 * Opens the per-user channel. Auth is registered on the socket *before* the
 * join goes out — the same ordering chat uses — so the change filter never
 * registers as `anon` and the `wait: true` join holds until delivery is
 * actually authorised.
 *
 * The optional signal is what makes this safe under React StrictMode's
 * mount → unmount → remount: the client memoises channels by topic, so a
 * second effect run that found the first run's still-joining channel would
 * throw on `.on()`. An aborted signal makes the first run return before it
 * ever asks for the channel, so only the live effect owns the topic.
 *
 * The returned teardown removes the channel; an async setup that completes
 * after unmount removes itself the moment it lands.
 */
export async function subscribeToNotifications(
  client: SupabaseClient,
  userId: string,
  onInsert: () => void,
  signal?: AbortSignal,
): Promise<() => void> {
  await client.realtime.setAuth();
  if (signal?.aborted) {
    return () => {};
  }

  const channel = client
    .channel(`notifications-${userId}`, {
      config: { postgres_changes_options: { wait: true } },
    })
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `user_id=eq.${userId}`,
      },
      () => onInsert(),
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * The polling fallback: wake on tab focus (the moment a student returns and
 * the badge is most likely stale) and on a coarse interval. Returns its own
 * cleanup so callers compose the two.
 */
export function watchNotificationWakeups(
  onWake: () => void,
  intervalMs: number = POLL_INTERVAL_MS,
): () => void {
  const onFocus = () => onWake();
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      onWake();
    }
  };

  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  const timer = setInterval(onWake, intervalMs);

  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    clearInterval(timer);
  };
}
