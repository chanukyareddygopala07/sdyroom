import type { SupabaseClient } from "@supabase/supabase-js";

import type { CreateReportInput, MuteDuration } from "../validation/moderation";
import { ModerationError, moderationErrorFrom } from "./errors";

/**
 * Every moderation operation is an RPC call — the tables themselves are not
 * readable or writable from PostgREST (`moderation_reports`,
 * `moderation_actions` and `room_moderators` have zero grants; `room_mutes`
 * and `user_blocks` expose only the caller's own rows for the chat filter).
 * This module is the single place the wire shape of those RPC envelopes is
 * interpreted; routes only ever see typed results or a `ModerationError`.
 */

export type ReportSubjectType = "user" | "message" | "resource";
export type ReportStatusValue = "pending" | "reviewing" | "resolved" | "dismissed";

/** Explicit projection of `room_report_list` — never contains a reporter id. */
export type ReportSummary = {
  id: string;
  subject_type: ReportSubjectType;
  subject_id: string | null;
  subject_alias: string | null;
  reason: string;
  detail: string | null;
  status: ReportStatusValue;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

export type CreateReportResult =
  | { code: "created"; id: string; status: "pending"; created_at: string }
  | { code: "duplicate"; id: string; status: ReportStatusValue };

export type BlockEntry = { alias: string; created_at: string };

/** Explicit projection of `room_moderation_info` — aliases only, no ids. */
export type RoomModerationInfo = {
  can_moderate: boolean;
  moderator_aliases: string[];
  muted_aliases: string[];
  viewer_is_muted: boolean;
  muted_until: string | null;
};

export type MemberActionResult =
  | { code: "removed"; member_count?: number; removed?: boolean }
  | { code: "muted"; muted_until: string }
  | { code: "unmuted" }
  | { code: "updated"; role: "owner" | "moderator" | "student"; changed: boolean }
  | { code: "unchanged"; role: "owner" | "moderator" | "student"; changed: boolean };

type Envelope = Record<string, unknown>;

async function callRpc(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Envelope> {
  const { data, error } = await client.rpc(fn, args);

  if (error) {
    // Documented codes come back as a successful RPC result; an error here
    // means the call itself failed (permission, network, bad argument) and is
    // deliberately not forwarded to the client.
    throw new Error(`${fn} failed: ${error.message}`);
  }

  const envelope = data && typeof data === "object" ? (data as Envelope) : null;
  if (!envelope) {
    throw new Error(`Unexpected moderation result from ${fn}`);
  }

  const failure = moderationErrorFrom(envelope);
  if (failure) {
    throw failure;
  }
  return envelope;
}

/**
 * `subject_ref` is a single text on the wire: the alias for a user subject,
 * the uuid for message/resource subjects. The RPC re-validates both forms.
 */
export async function createReport(
  client: SupabaseClient,
  roomId: string,
  input: CreateReportInput,
): Promise<CreateReportResult> {
  const subjectRef =
    input.subject_type === "user" ? input.subject_alias : input.subject_id;
  const envelope = await callRpc(client, "create_moderation_report", {
    p_room_id: roomId,
    p_subject_type: input.subject_type,
    p_subject_ref: subjectRef,
    p_reason: input.reason,
    p_detail: input.detail,
  });

  if (envelope.code === "created" || envelope.code === "duplicate") {
    return envelope as CreateReportResult;
  }
  throw new Error(`Unexpected create_moderation_report result: ${JSON.stringify(envelope).slice(0, 200)}`);
}

export async function listReports(
  client: SupabaseClient,
  roomId: string,
  limit?: number,
): Promise<ReportSummary[]> {
  const envelope = await callRpc(client, "room_report_list", {
    p_room_id: roomId,
    p_limit: limit ?? 50,
  });
  if (envelope.code !== "ok") {
    throw new Error(`Unexpected room_report_list result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  const reports = Array.isArray(envelope.reports) ? envelope.reports : [];
  return reports as ReportSummary[];
}

export async function setReportStatus(
  client: SupabaseClient,
  reportId: string,
  status: string,
): Promise<{ id: string; status: ReportStatusValue }> {
  const envelope = await callRpc(client, "set_moderation_report_status", {
    p_report_id: reportId,
    p_status: status,
  });
  if (envelope.code !== "updated") {
    throw new Error(`Unexpected set_moderation_report_status result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  return { id: String(envelope.id), status: envelope.status as ReportStatusValue };
}

export async function removeMember(
  client: SupabaseClient,
  roomId: string,
  alias: string,
): Promise<{ member_count: number | null }> {
  const envelope = await callRpc(client, "remove_room_member", {
    p_room_id: roomId,
    p_member_alias: alias,
  });
  if (envelope.code !== "removed") {
    throw new Error(`Unexpected remove_room_member result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  const count = Number(envelope.member_count);
  return { member_count: Number.isFinite(count) ? count : null };
}

const MUTE_INTERVALS: Record<MuteDuration, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
};

export async function muteMember(
  client: SupabaseClient,
  roomId: string,
  alias: string,
  duration: MuteDuration,
): Promise<{ muted_until: string }> {
  const envelope = await callRpc(client, "mute_room_member", {
    p_room_id: roomId,
    p_member_alias: alias,
    p_interval: MUTE_INTERVALS[duration],
  });
  if (envelope.code !== "muted") {
    throw new Error(`Unexpected mute_room_member result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  return { muted_until: String(envelope.muted_until) };
}

export async function unmuteMember(
  client: SupabaseClient,
  roomId: string,
  alias: string,
): Promise<void> {
  const envelope = await callRpc(client, "unmute_room_member", {
    p_room_id: roomId,
    p_member_alias: alias,
  });
  if (envelope.code !== "unmuted") {
    throw new Error(`Unexpected unmute_room_member result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
}

export async function setModerator(
  client: SupabaseClient,
  roomId: string,
  alias: string,
  on: boolean,
): Promise<{ role: string; changed: boolean }> {
  const envelope = await callRpc(client, "set_room_moderator", {
    p_room_id: roomId,
    p_member_alias: alias,
    p_on: on,
  });
  if (envelope.code !== "updated" && envelope.code !== "unchanged") {
    throw new Error(`Unexpected set_room_moderator result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  return { role: String(envelope.role), changed: envelope.changed === true };
}

export async function createBlock(
  client: SupabaseClient,
  alias: string,
): Promise<{ alias: string; created_at: string; created: boolean }> {
  const envelope = await callRpc(client, "create_user_block", { p_alias: alias });
  if (envelope.code !== "created" && envelope.code !== "exists") {
    throw new Error(`Unexpected create_user_block result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  return {
    alias: String(envelope.alias),
    created_at: String(envelope.created_at),
    created: envelope.code === "created",
  };
}

export async function deleteBlock(
  client: SupabaseClient,
  alias: string,
): Promise<{ removed: boolean }> {
  const envelope = await callRpc(client, "delete_user_block", { p_alias: alias });
  if (envelope.code !== "removed") {
    throw new Error(`Unexpected delete_user_block result: ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  return { removed: envelope.removed === true };
}

/** `list_my_blocks` is a set-returning function: rows, not an envelope. */
export async function listBlocks(client: SupabaseClient): Promise<BlockEntry[]> {
  const { data, error } = await client.rpc("list_my_blocks", {});
  if (error) {
    throw new Error(`list_my_blocks failed: ${error.message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error("Unexpected list_my_blocks result");
  }
  return data as BlockEntry[];
}

/**
 * Reads the room's moderation surface for the page/UI. Non-membership comes
 * back as a raised 42501 from the SECURITY DEFINER body, mapped here to the
 * same not_found an absent room would produce so the caller learns nothing.
 */
export async function getRoomModerationInfo(
  client: SupabaseClient,
  roomId: string,
): Promise<RoomModerationInfo> {
  const { data, error } = await client.rpc("room_moderation_info", {
    p_room_id: roomId,
  });

  if (error) {
    if (error.message.includes("permission denied for room moderation")) {
      throw new ModerationError(
        "not_found",
        "That room does not exist or is not available.",
        404,
      );
    }
    if (error.message.includes("requires an authenticated user")) {
      throw new ModerationError("unauthenticated", "Sign in to continue.", 401);
    }
    throw new Error(`room_moderation_info failed: ${error.message}`);
  }

  const info = data as Partial<RoomModerationInfo> | null;
  if (!info || typeof info.can_moderate !== "boolean") {
    throw new Error("Unexpected room_moderation_info result");
  }
  return {
    can_moderate: info.can_moderate,
    moderator_aliases: Array.isArray(info.moderator_aliases) ? info.moderator_aliases : [],
    muted_aliases: Array.isArray(info.muted_aliases) ? info.muted_aliases : [],
    viewer_is_muted: info.viewer_is_muted === true,
    muted_until: info.muted_until ?? null,
  };
}
