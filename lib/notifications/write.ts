import type { SupabaseClient } from "@supabase/supabase-js";

import type { NotificationPayload } from "./types";

/**
 * The writer — the only supported way a row reaches `notifications`.
 *
 * Every call is **best-effort by contract**: an invitation must succeed even
 * if the notification write fails, and so must a mute. Nothing in this module
 * throws into its caller; failures are logged and swallowed, and the unit
 * tests force a rejecting RPC to prove it.
 *
 * Writes go through SECURITY DEFINER RPCs because `notifications` carries no
 * INSERT grant — one user notifying another is only possible inside the
 * producer-authorization table documented in `0011_notifications.sql`. The
 * room-shaped events take the target's **alias** (the only identity a route
 * legitimately holds); the uuid is resolved inside the request via
 * `moderation_resolve_alias` and never returns to the client. Report events
 * take only the report id: the reporter's uuid has no SELECT grant anywhere,
 * so `push_report_notification` derives the recipient itself.
 */

export type RoomNotificationEvent = {
  kind: "room";
  type:
    | "invite_created"
    | "invite_accepted"
    | "member_removed"
    | "muted"
    | "moderation_resolved"
    | "resource_ready"
    | "ai_task_complete"
    | "system";
  roomId: string;
  targetAlias: string;
  payload: NotificationPayload;
  dedupeKey?: string;
};

export type ReportNotificationEvent = {
  kind: "report";
  type: "report_resolved";
  reportId: string;
  payload: NotificationPayload;
  dedupeKey?: string;
};

export type NotifyEvent = RoomNotificationEvent | ReportNotificationEvent;

/** Subject keys the dedupe index collapses on — one unread row per key. */
export function roomDedupeKey(type: string, roomId: string): string {
  return `${type}:${roomId}`;
}

export function reportDedupeKey(reportId: string): string {
  return `report_resolved:${reportId}`;
}

type RpcResult = { data: unknown; error: { message: string } | null };

export async function notify(
  client: SupabaseClient,
  event: NotifyEvent,
): Promise<void> {
  try {
    if (event.kind === "report") {
      const result = await client.rpc("push_report_notification", {
        p_report_id: event.reportId,
        p_type: event.type,
        p_payload: event.payload,
        p_dedupe_key: event.dedupeKey ?? null,
      });
      logUnexpected(event, result as RpcResult);
      return;
    }

    const resolution = (await client.rpc("moderation_resolve_alias", {
      p_alias: event.targetAlias,
    })) as RpcResult;

    if (resolution.error) {
      throw new Error(`moderation_resolve_alias failed: ${resolution.error.message}`);
    }
    const targetId = resolution.data;
    if (typeof targetId !== "string" || targetId.length === 0) {
      // The alias did not resolve: nothing to notify, and inventing a uuid
      // is exactly what the RPC would refuse anyway.
      console.error(
        `[notify] unresolved target alias for ${event.type}:`,
        event.targetAlias,
      );
      return;
    }

    const result = await client.rpc("push_notification", {
      p_user_id: targetId,
      p_type: event.type,
      p_payload: event.payload,
      p_room_id: event.roomId,
      p_dedupe_key: event.dedupeKey ?? null,
    });
    logUnexpected(event, result as RpcResult);
  } catch (error) {
    console.error(`[notify] ${event.type} failed:`, error);
  }
}

function logUnexpected(event: NotifyEvent, result: RpcResult): void {
  if (result.error) {
    throw new Error(`notification RPC failed: ${result.error.message}`);
  }
  const envelope =
    result.data && typeof result.data === "object"
      ? (result.data as { code?: string })
      : null;
  const code = envelope?.code;
  // `muted` is the preference system doing its job, and `deduped` is the
  // collapse rule; anything else is worth an operator's eye in the logs.
  if (code !== "created" && code !== "deduped" && code !== "muted") {
    console.error(
      `[notify] ${event.type} returned unexpected code:`,
      code ?? "null",
      envelope ?? result.data,
    );
  }
}
