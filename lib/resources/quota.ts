import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage quota numbers for one scope, as `GET /api/resources` returns them.
 *
 * `used_bytes`/`limit_bytes` describe the scope being listed (the caller's
 * own total for the personal library, the room's total for a room); the
 * `user_*` pair is always present so a room view can still explain an upload
 * that the caller's personal limit refused.
 */
export type ResourceQuota = {
  scope: "user" | "room";
  used_bytes: number;
  limit_bytes: number;
  user_used_bytes: number;
  user_limit_bytes: number;
};

/**
 * Pre-check: may `addBytes` more be uploaded right now?
 *
 * Called by the upload route *before* the bytes are put to storage, so an
 * over-quota upload costs a 409 instead of a write-then-rollback. It is only
 * a pre-check — the `study_resources_quota_guard` trigger (migration 0010)
 * is the authority and re-decides inside the inserting transaction, which is
 * what makes concurrent uploads race-safe.
 *
 * **Fails open**, matching the rate limiter: an error here is logged and the
 * upload proceeds, because the trigger still enforces the limit at insert
 * time and a broken pre-check must not become an outage.
 */
export async function resourceQuotaOk(
  client: SupabaseClient,
  roomId: string | null,
  addBytes: number,
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("resource_quota_ok", {
      p_room_id: roomId,
      p_add_bytes: addBytes,
    });
    if (error) {
      console.error("[resources/quota] pre-check failed:", error.message);
      return true;
    }
    // Only an explicit `false` refuses; an unexpected payload shape allows.
    return data !== false;
  } catch (error) {
    console.error(
      "[resources/quota] pre-check threw:",
      error instanceof Error ? error.message : error,
    );
    return true;
  }
}

/**
 * Quota numbers for the scope being listed.
 *
 * Unlike the pre-check this **throws** on failure: it feeds a response
 * field, and answering `200` without `quota` would break the contract the UI
 * renders from. The route maps the failure to its existing 500.
 */
export async function fetchResourceQuota(
  client: SupabaseClient,
  roomId: string | null,
): Promise<ResourceQuota> {
  const { data, error } = await client.rpc("resource_quota", {
    p_room_id: roomId,
  });

  if (error) {
    throw new Error(`resource quota failed: ${error.message}`);
  }
  if (
    data === null ||
    typeof data !== "object" ||
    typeof (data as { used_bytes?: unknown }).used_bytes !== "number" ||
    typeof (data as { limit_bytes?: unknown }).limit_bytes !== "number"
  ) {
    throw new Error("resource quota returned an unexpected shape");
  }

  return data as ResourceQuota;
}
