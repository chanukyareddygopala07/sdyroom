import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessageView } from "./types";

export type ChatErrorCode = "validation" | "not_found";

/** Failure carrying the HTTP status the API layer returns. */
export class ChatError extends Error {
  readonly code: ChatErrorCode;
  readonly status: number;

  constructor(code: ChatErrorCode, message: string, status: number) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.status = status;
  }
}

const INVALID_CURSOR_MESSAGE = "That message cursor is not valid.";
const ROOM_MISSING = "That room does not exist or is not available.";

/**
 * Columns the view needs. `user_id` never leaves the API — it is only the
 * input to the viewer-relative `is_own` flag — and `seq` stays a pagination
 * detail: the `before` cursor crosses the wire as a message id.
 */
const MESSAGE_COLUMNS = "id, user_id, alias, body, created_at";

function envelopeOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses a raw message row — a history page, a send confirmation, or a
 * Realtime `record` — onto the exposed view shape, or throws on malformed
 * data. All three producers share this mapping so the client cannot tell
 * them apart.
 */
export function toChatMessageView(
  value: unknown,
  viewerId: string,
): ChatMessageView {
  const row = envelopeOf(value);
  if (!row) {
    throw new Error("Missing message payload.");
  }

  const id = row.id;
  const userId = row.user_id;
  const alias = row.alias;
  const body = row.body;
  const createdAt = row.created_at;

  if (
    typeof id !== "string" ||
    typeof userId !== "string" ||
    typeof alias !== "string" ||
    typeof body !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new Error(
      `Unexpected message payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  return {
    id,
    alias,
    body,
    created_at: createdAt,
    status: "sent",
    is_own: userId === viewerId,
  };
}

export type ListMessagesInput = {
  roomId: string;
  /** The authenticated viewer; only they can appear as `is_own`. */
  viewerId: string;
  /** Message id whose page precedes the requested one; unset = newest. */
  before?: string | undefined;
  limit: number;
};

export type ListMessagesResult = {
  messages: ChatMessageView[];
  /** True when an older page exists below the oldest message returned. */
  has_more: boolean;
};

/**
 * One page of a room's history, oldest-to-newest within the page.
 *
 * Pagination walks `seq` — a monotonic insert order, so pages never overlap
 * or skip even when two messages share a `created_at` — but the cursor the
 * API exposes is a message id: callers never handle sequence numbers, and an
 * id from outside the room cannot be used to probe one.
 */
export async function listMessages(
  client: SupabaseClient,
  input: ListMessagesInput,
): Promise<ListMessagesResult> {
  let cursorSeq: number | null = null;

  if (input.before !== undefined) {
    const { data, error } = await client
      .from("room_messages")
      .select("seq")
      .eq("room_id", input.roomId)
      .eq("id", input.before)
      .maybeSingle();

    if (error) {
      throw new Error(`message cursor lookup failed: ${error.message}`);
    }
    if (!data) {
      throw new ChatError("validation", INVALID_CURSOR_MESSAGE, 400);
    }
    cursorSeq = data.seq;
  }

  let query = client
    .from("room_messages")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", input.roomId)
    .order("seq", { ascending: false })
    .limit(input.limit + 1);
  if (cursorSeq !== null) {
    query = query.lt("seq", cursorSeq);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`message list failed: ${error.message}`);
  }

  const rows = data ?? [];
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const messages = [...page]
    .reverse()
    .map((row) => toChatMessageView(row, input.viewerId));

  return { messages, has_more: hasMore };
}

export type CreateMessageInput = {
  roomId: string;
  /** From the verified session claims; RLS checks the same identity again. */
  userId: string;
  /** The sender's registered study alias, stamped onto the row at send time. */
  alias: string;
  body: string;
};

/**
 * Appends one message. Failure mapping: 42501 means RLS refused the insert
 * (the caller is no longer a member, or the row was forged) and 23503 means
 * the room vanished between the membership check and the write — both read
 * as the same 404 the rest of the room API gives, so the endpoint never
 * becomes an existence oracle.
 */
export async function createMessage(
  client: SupabaseClient,
  input: CreateMessageInput,
): Promise<ChatMessageView> {
  const { data, error } = await client
    .from("room_messages")
    .insert({
      room_id: input.roomId,
      user_id: input.userId,
      alias: input.alias,
      body: input.body,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "42501" || error.code === "23503") {
      throw new ChatError("not_found", ROOM_MISSING, 404);
    }
    throw new Error(`message insert failed: ${error.message}`);
  }

  return toChatMessageView(data, input.userId);
}
